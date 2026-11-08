"""Opt-in, scoped OpenAI runtime credential provisioning.

Only operates on the public OpenAI Administration API over TLS. Neither the
admin credential nor the issued service-account API key is persisted to state,
argv, environment, a file, or logs. The newly-issued key is returned once over
the local SwiftUI wizard stdin/stdout bridge for immediate Keychain storage.

Each non-idempotent mutation is journaled *before* the request. Unknown results
are reconciled by reading the named resource; never blindly repeat POSTs.
"""
from __future__ import annotations

import json
import re
import secrets
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlencode


RUNTIME_PERMISSIONS = ("api.organization.tunnel.read",
                       "api.organization.tunnel.use")
# The organization Default project cannot directly contain service accounts.
# Never offer it for the automatic Service Account provisioning workflow.
DEFAULT_PROJECT_NAMES = {"default", "default project", "проект по умолчанию"}
PROJECT_ID = re.compile(r"^proj[-_][A-Za-z0-9_-]{3,120}$")
# OpenAI Role.id is documented as an opaque string, not a guaranteed
# "role_" prefix. Validate URL/path safety, not an undocumented naming rule.
# IDs that begin with digits (for example ULID-style IDs) are valid.
RESOURCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,180}$")
API_BASE = "https://api.openai.com/v1"

# Safely diagnose an unexpected provider schema. Report only known field
# names/types, never raw JSON, token values or resource identifiers.
SAFE_SCHEMA_FIELDS = frozenset({
    "id", "role_id", "roleId", "name", "object", "role", "data", "error", "permissions",
    "resource_type", "created_at", "description", "message", "status",
    "code", "type", "detail", "success", "has_more", "next",
    "predefined_role", "group", "service_account", "api_key",
})

def safe_response_shape(value: dict) -> dict:
    keys = sorted(k for k in value if isinstance(k, str) and k in SAFE_SCHEMA_FIELDS)
    nested = value.get("role") if isinstance(value.get("role"), dict) else value.get("data")
    nested_keys = (sorted(k for k in nested if isinstance(k, str) and
                          k in SAFE_SCHEMA_FIELDS) if isinstance(nested, dict) else [])
    kind = value.get("object")
    if not isinstance(kind, str) or kind not in (
            "role", "list", "error", "response", "acknowledged"):
        kind = "other_or_missing"
    identifier = value.get("id")
    return {
        "fields": keys[:24],
        "nestedFields": nested_keys[:24],
        "idType": ("string" if isinstance(identifier, str) else
                   "absent" if identifier is None else type(identifier).__name__),
        "objectKind": kind,
        "containsErrorField": "error" in value,
    }


def role_id_diagnostic(record: dict | None) -> dict:
    """Read-only validation report for a Role returned by the OpenAI API.

    An organization role ID is an *opaque string*. It is supplied in JSON
    payloads when assigning roles, not interpolated into shell commands or
    URL paths here. Do not reject characters merely because they do not
    match the examples in the documentation.

    The role ID itself is returned to the **local wizard only for the
    owner's opt-in development diagnostic**. Never persist this report,
    log it, or return the Admin API Key.
    """
    if not isinstance(record, dict):
        return {"id": "", "idType": "absent", "object": "", "resourceType": "",
                "reason": "role_not_found", "accepted": False}
    raw = next((record[k] for k in ("id", "role_id", "roleId") if k in record), None)
    role_id = raw if isinstance(raw, str) else ""
    object_kind = str(record.get("object") or "")[:80]
    resource_type = str(record.get("resource_type") or "")[:80]
    id_type = ("string" if isinstance(raw, str) else
               "absent" if raw is None else type(raw).__name__)
    if record.get("object") not in (None, "role"):
        reason = "wrong_object_kind"
    elif record.get("resource_type") not in (None, "api.organization"):
        reason = "wrong_resource_type"
    elif not isinstance(raw, str):
        reason = "id_not_string"
    elif not raw.strip():
        reason = "empty_id"
    elif len(raw) < 3 or len(raw) > 256 or any(
        ord(c) < 33 or ord(c) > 126 or c in "/\\"
        for c in raw
    ):
        reason = "unsafe_id_bytes"
    elif raw.startswith(("sk-", "sk_")):
        reason = "secret_not_role_id"
    else:
        reason = "accepted"
    return {"id": role_id[:512] if not role_id.startswith(("sk-", "sk_")) else "<redacted>",
            "idType": id_type, "object": object_kind, "resourceType": resource_type,
            "reason": reason, "accepted": reason == "accepted"}


def valid_role_id(record: dict) -> str | None:
    diagnostic = role_id_diagnostic(record)
    return diagnostic["id"] if diagnostic["accepted"] else None


class RuntimeAdminError(Exception):
    pass


class KnownRejection(RuntimeAdminError):
    """Definitive HTTP rejection; it is safe to retry *after permissions change*."""


class RuntimeAdminAPI:
    # After a confirmed HTTP success with no recognized resource ID, reads
    # may lag behind writes. Perform a short bounded GET-only reconciliation.
    # Never POST again as part of this sequence.
    reconciliation_delays = (0.0, 0.5, 1.25)

    def api(self, admin: str, method: str, path: str, payload: dict | None = None) -> dict:
        # URL is assembled exclusively from known endpoints and validated IDs.
        if not re.fullmatch(r"/[a-zA-Z0-9_./?&=+-]{1,220}", path):
            raise RuntimeAdminError("Недопустимый путь OpenAI Admin API.")
        if method not in ("GET", "POST"):
            raise RuntimeAdminError("Недопустимый метод OpenAI Admin API.")
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(
            API_BASE + path, data=data, method=method,
            headers={"Authorization": "Bearer " + admin,
                     "Accept": "application/json", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=22) as response:
                # Numeric HTTP status only; no headers, request identifiers,
                # response values or secrets are persisted to diagnostics.
                self.last_http_status = getattr(response, "status", None)
                body = response.read(131073)
        except urllib.error.HTTPError as exc:
            # Provider messages may echo input; never surface raw response bodies.
            if exc.code in (400, 401, 403, 404, 409, 422):
                raise KnownRejection("OpenAI отклонил запрос (" + str(exc.code) +
                                     "). Проверь права администратора, проект и политику организации.") from None
            raise RuntimeAdminError("OpenAI временно недоступен (HTTP " +
                                    str(exc.code) + "). Статус операции нужно сверить.") from None
        except (OSError, TimeoutError):
            raise RuntimeAdminError("Нет подтверждения от OpenAI. Повтор без сверки запрещён.") from None
        if len(body) > 131072:
            raise RuntimeAdminError("Слишком большой ответ от OpenAI — операция остановлена.")
        try:
            decoded = json.loads(body)
        except (ValueError, UnicodeError):
            raise RuntimeAdminError("OpenAI вернул неподдерживаемый ответ.") from None
        if not isinstance(decoded, dict):
            raise RuntimeAdminError("OpenAI вернул неподдерживаемые данные.")
        return decoded

    def list_rows(self, admin: str, path: str, limit: int = 100) -> list[dict]:
        rows: list[dict] = []
        after = ""
        for _ in range(8):
            separator = "&" if "?" in path else "?"
            page = self.api(admin, "GET", path + separator + "limit=" + str(limit) +
                            ("&after=" + after if after else ""))
            new = page.get("data")
            if not isinstance(new, list) or any(not isinstance(x, dict) for x in new):
                raise RuntimeAdminError("Некорректный список ресурсов OpenAI.")
            rows.extend(new)
            more = bool(page.get("has_more")) or bool(page.get("next"))
            if not more:
                return rows
            next_id = page.get("next") or page.get("last_id")
            if not isinstance(next_id, str) or not RESOURCE_ID.fullmatch(next_id):
                raise RuntimeAdminError("Нельзя безопасно продолжить список OpenAI.")
            after = next_id
        raise RuntimeAdminError("Слишком много записей OpenAI. Выбери ручную настройку.")

    def projects(self, admin: str) -> list[dict]:
        projects = self.list_rows(admin, "/organization/projects")
        result = []
        for row in projects:
            if row.get("status") == "archived":
                continue
            name = str(row.get("name") or row.get("id") or "").strip()
            if (row.get("is_default") is True or row.get("isDefault") is True or
                name.casefold() in DEFAULT_PROJECT_NAMES):
                continue
            identifier = row.get("id")
            if isinstance(identifier, str) and PROJECT_ID.fullmatch(identifier):
                result.append({"id":identifier, "name":name[:100]})
        return result


class RuntimeAutoProvisioner:
    def __init__(self, engine: Any, transport: RuntimeAdminAPI | None = None):
        self.engine = engine
        self.transport = transport or RuntimeAdminAPI()

    def projects(self, data: dict) -> dict:
        admin = self.admin(data)
        return {"projects": self.transport.projects(admin)}

    @staticmethod
    def admin(data: dict) -> str:
        admin = str(data.get("adminKey") or "").strip()
        if (len(admin) < 8 or len(admin) > 4096 or
            any(ord(ch) < 33 or ord(ch) == 127 for ch in admin)):
            raise RuntimeAdminError("Введите Admin API Key с правами управления проектами, ролями и ключами.")
        return admin

    def saved(self, state: dict, journal: dict) -> None:
        state["runtimeProvision"] = journal
        self.engine.write_state(state)

    @staticmethod
    def default_project(row: dict) -> bool:
        name = str(row.get("name") or "").strip().casefold()
        return (row.get("is_default") is True or row.get("isDefault") is True
                or name in DEFAULT_PROJECT_NAMES)

    def inspect(self, data: dict) -> dict:
        """Read-only, never creates resources or changes the local journal."""
        admin = self.admin(data)
        state = self.engine.read_state()
        journal = state.get("runtimeProvision") or {}
        suffix = journal.get("suffix") or ""
        prior_project = journal.get("projectId") or ""
        projects = self.transport.list_rows(admin, "/organization/projects")
        selected = next((x for x in projects if x.get("id") == prior_project), None)
        roles = self.transport.list_rows(admin, "/organization/roles")
        matches = [r for r in roles if r.get("name") == "McpGo Runtime " + suffix]
        if len(matches) > 1:
            raise RuntimeAdminError("Найдено несколько ролей McpGo с одинаковым именем. Нужна ручная проверка.")
        role = matches[0] if matches else None
        role_permissions_valid = (role is not None and
            isinstance(role.get("permissions"),list) and
            set(role["permissions"]) == set(RUNTIME_PERMISSIONS))
        role_id_valid = valid_role_id(role) is not None
        role_valid = role_permissions_valid and role_id_valid
        present_permissions = (
            set(role["permissions"]) if role and isinstance(role.get("permissions"), list)
            and all(isinstance(x, str) for x in role["permissions"]) else set()
        )
        # Expose safe read-only progress; do not return user names, keys,
        # project IDs, role IDs or entire provider responses.
        replacement = [r for r in roles if
                       r.get("name") == "McpGo Runtime " + suffix + " Restricted"]
        safe_failure = journal.get("lastFailure")
        if not isinstance(safe_failure, dict):
            safe_failure = {}
        key_status = str(journal.get("status") or "")
        # Read-only inventory, scoped to the previously created service account.
        # OpenAI does NOT return an API key's plaintext from this endpoint.
        previous_account = (journal.get("resources") or {}).get("service-account")
        key_count = 0
        key_inventory_checked = False
        if key_status in ("key-issuing", "key-issued", "recovery-key-issuing") and (
                PROJECT_ID.fullmatch(prior_project) and isinstance(previous_account,str)):
            keys = self.transport.list_rows(
                admin, "/organization/projects/"+prior_project+
                "/api_keys?owner_project_access=any")
            key_inventory_checked = True
            for row in keys:
                owner = row.get("owner") if isinstance(row.get("owner"),dict) else {}
                service_account = owner.get("service_account") if isinstance(owner.get("service_account"),dict) else {}
                if (owner.get("type") == "service_account" and
                    service_account.get("id") == previous_account):
                    key_count += 1
        return {
            "keyIssuanceStatus": key_status if key_status in (
                "key-issuing", "key-issued", "recovery-key-issuing") else "none",
            "keyRecoveryAlreadyAttempted": bool(journal.get("keyRecoveryAttempted")),
            "serviceAccountReady": isinstance(previous_account,str) and bool(previous_account),
            "serviceAccountKeyInventoryChecked": key_inventory_checked,
            "serviceAccountKeyCount": min(key_count, 99),
            "rolePermissionsValid": role_permissions_valid,
            "roleHasValidID": role_id_valid,
            "roleResponseShape": safe_response_shape(role) if isinstance(role,dict) else {},
            # Ephemeral, read-only diagnostic explicitly requested by the
            # application owner. Never written to state.json or logs.
            "roleIDDiagnostic": role_id_diagnostic(role),
            "lastFailure": {k: safe_failure[k] for k in
                            ("operation", "source", "httpStatus", "responseShape",
                             "matchingNamesAfter", "listCountAfter")
                            if k in safe_failure},
            "replacementRoleFound": len(replacement) == 1,
            "replacementRoleValid": len(replacement) == 1 and
                isinstance(replacement[0].get("permissions"),list) and
                set(replacement[0]["permissions"]) == set(RUNTIME_PERMISSIONS) and
                valid_role_id(replacement[0]) is not None,
            "roleMissingPermissions": sorted(set(RUNTIME_PERMISSIONS) - present_permissions),
            "roleUnexpectedPermissions": sorted(present_permissions - set(RUNTIME_PERMISSIONS))[:30],
            "priorProjectSelected": bool(prior_project),
            "priorProjectIsDefault": bool(selected and self.default_project(selected)),
            "priorProjectAvailable": selected is not None,
            "pendingKind": str(journal.get("pending") or ""),
            "roleFound": role is not None,
            "roleValid": role_valid,
            "roleRetryAlreadyUsed": bool(journal.get("roleRetryUsed")),
        }

    def resource(self, state: dict, journal: dict, admin: str, kind: str,
                 list_path: str, create_path: str, name: str, payload: dict,
                 *, permissions: tuple[str, ...] | None = None,
                 retry_missing_role: bool = False) -> str:
        resources = journal.setdefault("resources", {})
        if kind in resources:
            return resources[kind]
        rows = self.transport.list_rows(admin, list_path, limit=100)
        matches = [row for row in rows if row.get("name") == name]
        created_now = False
        creation_status = None
        if len(matches) > 1:
            raise RuntimeAdminError("Несколько ресурсов с именем McpGo. Автоматическая настройка остановлена.")
        if matches:
            resource = matches[0]
        else:
            if journal.get("pending") == kind:
                if (kind != "role" or not retry_missing_role or
                    journal.get("roleRetryUsed")):
                    raise RuntimeAdminError(
                        "Предыдущий запрос создания " + kind +
                        " не подтверждён. McpGo не повторяет его без отдельного согласия. " +
                        "Нажми «Проверить ресурсы OpenAI» и следуй подсказке.")
                # Explicit second confirmation, after a fresh exact-name GET
                # above found no role. Allow at most one attempted retry.
                journal["roleRetryUsed"] = True
            journal["pending"] = kind
            self.saved(state, journal)
            try:
                resource = self.transport.api(admin, "POST", create_path, payload)
                created_now = True
                creation_status = getattr(self.transport, "last_http_status", None)
            except KnownRejection:
                journal["pending"] = None
                self.saved(state, journal)
                raise
            # Any timeout or other unknown leaves the pending marker intact.
        # Save no raw values: just the schema shape of the response.
        response_shape = safe_response_shape(resource)
        # Some response formats return the resource beneath a named envelope,
        # even when the list endpoint returns it directly. Inspect known nested
        # objects only; never include raw response bodies in errors or logs.
        nested = resource.get(kind.replace("-", "_"))
        if not isinstance(nested, dict):
            nested = resource.get("data") if isinstance(resource.get("data"), dict) else resource
        if isinstance(nested, dict):
            resource = nested
        identifier = resource.get("id")
        is_role = kind in ("role", "replacement-role")
        if (is_role and resource.get("name") == name and
            isinstance(resource.get("permissions"),list) and
            set(resource["permissions"]) == set(RUNTIME_PERMISSIONS)):
            identifier = valid_role_id(resource)
        valid_identifier = (isinstance(identifier,str) and
            resource.get("name") == name and valid_role_id(resource) == identifier
            ) if is_role else (
            isinstance(identifier, str) and RESOURCE_ID.fullmatch(identifier) is not None)
        if not valid_identifier:
            # POST may have succeeded but a response format changed. Perform
            # read-only reconciliation by exact deterministic resource name.
            # Keep the pending marker if no match; never repeat POST blindly.
            fresh: list[dict] = []
            matches: list[dict] = []
            delays = getattr(self.transport, "reconciliation_delays", (0.0,))
            for wait in delays:
                if wait > 0:
                    time.sleep(min(float(wait), 2.0))
                fresh = self.transport.list_rows(admin, list_path, limit=100)
                matches = [row for row in fresh if row.get("name") == name]
                if len(matches) == 1:
                    candidate = matches[0].get("id")
                    if kind in ("role", "replacement-role"):
                        if (isinstance(matches[0].get("permissions"),list) and
                            set(matches[0]["permissions"]) == set(RUNTIME_PERMISSIONS)):
                            candidate = valid_role_id(matches[0])
                    valid_candidate = (isinstance(candidate,str) and bool(candidate)) if is_role else (
                        isinstance(candidate,str) and RESOURCE_ID.fullmatch(candidate) is not None)
                    if valid_candidate:
                        resource = matches[0]
                        identifier = candidate
                        break
                if len(matches) > 1:
                    break
            if not (isinstance(identifier,str) and identifier and
                    (is_role or RESOURCE_ID.fullmatch(identifier))):
                journal["lastFailure"] = {
                    "operation": kind if kind in ("project", "role", "replacement-role",
                                                 "group", "service-account") else "other",
                    "source": "post" if created_now else "read",
                    "httpStatus": creation_status if isinstance(creation_status,int)
                                  and 100 <= creation_status <= 599 else None,
                    "responseShape": response_shape,
                    "matchingNamesAfter": min(len(matches), 99),
                    "listCountAfter": min(len(fresh), 999),
                }
                self.saved(state, journal)
                raise RuntimeAdminError(
                    ("Создание ресурса в OpenAI не удалось подтвердить. " if created_now
                     else "Существующий ресурс OpenAI не имеет подтверждённого ID. ") +
                    "Ответ не соответствует документированному формату. "
                    "Не создавай новый ресурс: повтор заблокирован. "
                    "Нажми «Проверить ресурсы OpenAI» для безопасной диагностики "
                    "или используй ручной Runtime API Key.")
        if permissions is not None:
            supplied = resource.get("permissions")
            if not isinstance(supplied, list) or set(supplied) != set(permissions):
                # Never accept a role without proving the least-privilege scope.
                raise RuntimeAdminError("Роль не соответствует минимальным разрешениям Read + Use.")
        if kind == "group" and resource.get("is_scim_managed"):
            raise RuntimeAdminError("Существующая группа управляется SCIM и не подходит.")
        resources[kind] = identifier
        journal["pending"] = None
        self.saved(state, journal)
        return identifier

    def assign(self, state: dict, journal: dict, admin: str,
               kind: str, list_path: str, create_path: str,
               expected_id: str, payload: dict) -> None:
        resources = journal.setdefault("resources", {})
        if resources.get(kind) == "assigned":
            return
        entries = self.transport.list_rows(admin, list_path, limit=100)
        def row_id(row: dict) -> str:
            # OpenAI list-role responses use a top-level Role.id, while the
            # create-assignment response nests its Role under "role".
            embedded = row.get("role") if kind == "role-assignment" else None
            return (embedded.get("id", "") if isinstance(embedded, dict)
                    else row.get("id", ""))
        if not any(row_id(entry) == expected_id for entry in entries):
            if journal.get("pending") == kind:
                raise RuntimeAdminError("Не подтверждено прежнее назначение прав " +
                                        kind + ". Проверь в OpenAI Platform.")
            journal["pending"] = kind
            self.saved(state, journal)
            try:
                self.transport.api(admin, "POST", create_path, payload)
            except KnownRejection:
                journal["pending"] = None
                self.saved(state, journal)
                raise
        resources[kind] = "assigned"
        journal["pending"] = None
        self.saved(state, journal)

    def recover_key(self, data: dict) -> dict:
        """One explicitly authorized replacement key for a prior uncertain POST.

        The original secret may have been created but lost in transit. An
        administrative GET may show its metadata, never its secret. Do not
        retry any former operation except a single new key issuance for the
        existing service account. The owner must explicitly acknowledge a
        potentially orphaned prior key.
        """
        if (data.get("confirmed") is not True or
            data.get("acknowledgePossiblePreviousKey") is not True):
            raise RuntimeAdminError("Нужно явно подтвердить выпуск нового ключа и возможное существование прежнего.")
        admin = self.admin(data)
        state = self.engine.read_state()
        journal = state.get("runtimeProvision") or {}
        if journal.get("status") not in ("key-issuing", "key-issued"):
            raise RuntimeAdminError("Восстановление доступно только после неподтверждённого выпуска ключа.")
        if journal.get("keyRecoveryAttempted"):
            raise RuntimeAdminError("Новый ключ уже запрашивался. Повтор запрещён.")
        project = journal.get("projectId")
        resources = journal.get("resources") or {}
        account = resources.get("service-account")
        for prerequisite in ("role", "group", "role-assignment",
                             "service-account", "account-membership"):
            if not resources.get(prerequisite):
                raise RuntimeAdminError(
                    "Настройка не завершила этап " + prerequisite +
                    ". Повторное создание ключа запрещено.")
        if not (isinstance(project,str) and PROJECT_ID.fullmatch(project) and
                isinstance(account,str) and RESOURCE_ID.fullmatch(account)):
            raise RuntimeAdminError("Не найдена подтверждённая связка проекта и Service Account.")
        expected_name = "McpGo Runtime " + str(journal.get("suffix") or "")
        accounts = self.transport.list_rows(
            admin, "/organization/projects/"+project+"/service_accounts")
        matches = [row for row in accounts if row.get("id") == account and
                   row.get("name") == expected_name]
        if len(matches) != 1:
            raise RuntimeAdminError("Service Account не подтверждён OpenAI. Ничего не создаём.")
        # Read-only list of existing keys before a replacement. We never
        # retrieve (nor print) secret values, and never delete old credentials.
        keys = self.transport.list_rows(
            admin, "/organization/projects/"+project+"/api_keys?owner_project_access=any")
        if not isinstance(keys,list):
            raise RuntimeAdminError("Не удалось подтвердить существующие ключи.")
        # Metadata-only inventory; the full credential is not retrievable.
        # Do not mutate or revoke any older key, even if its record exists.
        journal["keyRecoveryAttempted"] = True
        journal["status"] = "recovery-key-issuing"
        self.saved(state,journal)
        name = expected_name + " Recovery"
        try:
            response = self.transport.api(
                admin, "POST", "/organization/projects/"+project+
                "/service_accounts/"+account+"/api_keys",
                {"name":name, "scopes":list(RUNTIME_PERMISSIONS),
                 "expires_in_seconds":7776000})
        except KnownRejection:
            # A definitive HTTP rejection did not issue a key. Still require
            # operator review rather than silently repeating after a failure.
            journal["status"] = "key-recovery-rejected"
            self.saved(state,journal)
            raise
        value = response.get("value")
        identifier = response.get("id")
        if (not isinstance(value,str) or not value.startswith("sk-") or
            not isinstance(identifier,str) or not RESOURCE_ID.fullmatch(identifier)):
            raise RuntimeAdminError(
                "OpenAI не подтвердил новый ключ. Повтор запрещён. "
                "Проверь ключи в OpenAI Platform или используй ручную настройку.")
        journal["status"] = "key-issued"
        journal["keyId"] = identifier
        self.saved(state,journal)
        return {"runtimeKey":value, "message":"Новый ключ получен. Сохрани его в Keychain."}

    def provision(self, data: dict) -> dict:
        if data.get("confirmed") is not True:
            raise RuntimeAdminError("Создание проекта и Runtime API Key требует явного подтверждения.")
        admin = self.admin(data)
        create_project = data.get("createProject") is True
        project = str(data.get("projectId") or "").strip()
        if not create_project and not PROJECT_ID.fullmatch(project):
            raise RuntimeAdminError("Выбери существующий проект или разреши создать проект McpGo.")
        if create_project and project:
            raise RuntimeAdminError("Не указывай Project ID при создании нового проекта.")
        state = self.engine.read_state()
        tunnels = state.get("tunnels", {})
        if len(tunnels) != 2 or any(not tunnels.get(name, {}).get("id", "").startswith("tunnel_")
                                    for name in ("terminal", "browser")):
            raise RuntimeAdminError("Сначала создай два туннеля на шаге 3.")
        journal = state.get("runtimeProvision") or {}
        if journal.get("status") in ("key-issuing", "key-issued"):
            raise RuntimeAdminError("Ключ для этой установки уже выпускался. " +
                                    "Повторять выпуск автоматически нельзя. " +
                                    "Если ключ не сохранился в Keychain, используй ручную настройку.")
        retry_role = data.get("retryMissingRole") is True
        replace_invalid_role = data.get("replaceInvalidRole") is True
        if retry_role and replace_invalid_role:
            raise RuntimeAdminError("Выбери только одно действие для роли: повтор или замена.")
        if replace_invalid_role and journal.get("resources", {}).get("role"):
            raise RuntimeAdminError("Роль уже была подтверждена. Повторная замена запрещена.")
        if retry_role and (journal.get("pending") != "role" or journal.get("roleRetryUsed")):
            raise RuntimeAdminError("Повторное создание роли недоступно: состояние изменилось.")
        if data.get("replaceDefaultProject") is True and not create_project:
            raise RuntimeAdminError("Для смены Default project выбери «Создать проект McpGo».")

        suffix = journal.get("suffix") or secrets.token_hex(7)
        prior_project = journal.get("projectId")
        requested_mode = "create" if create_project else "existing"
        if prior_project:
            if not PROJECT_ID.fullmatch(prior_project):
                raise RuntimeAdminError("Некорректный проект из предыдущей настройки.")
            # Never create a second project just because the UI defaults to
            # "Create". Reconcile the previous selection first via read-only GET.
            projects = self.transport.list_rows(admin, "/organization/projects")
            selected = next((x for x in projects if x.get("id") == prior_project), None)
            if selected is None:
                raise RuntimeAdminError("Прежний проект недоступен. Проверь проекты в Platform.")
            if self.default_project(selected):
                if not (create_project and data.get("replaceDefaultProject") is True):
                    raise RuntimeAdminError("Ранее был выбран Default project. " +
                                            "Он не поддерживает Service Account. " +
                                            "Нажми «Проверить ресурсы OpenAI», " +
                                            "затем подтверди создание отдельного проекта McpGo.")
                if journal.get("resources",{}).get("service-account"):
                    raise RuntimeAdminError("У прежнего проекта уже есть Service Account. " +
                                            "Необходима ручная сверка.")
                # Explicitly authorized migration to dedicated project.
                # The pending role marker MUST survive the intervening
                # project creation. A project POST uses the single pending
                # slot, so preserve the role state separately until that
                # project has been resolved.
                if journal.get("pending") == "role":
                    journal["deferredPendingRole"] = True
                journal["priorDefaultProject"] = prior_project
                journal.pop("projectId",None)
                journal["projectMode"] = "create"
                prior_project = None
            else:
                if not create_project and project != prior_project:
                    raise RuntimeAdminError("Предыдущая настройка использовала другой проект.")
                project = prior_project
                journal["projectMode"] = "existing"
        else:
            if journal.get("projectMode") and journal["projectMode"] != requested_mode:
                raise RuntimeAdminError("Настройка уже начата для другого проекта. " +
                                        "Сначала заверши или восстанови её.")
            journal.setdefault("projectMode", requested_mode)
        journal["suffix"] = suffix
        self.saved(state, journal)

        if create_project and not prior_project:
            # Deterministic per-installation project name for safe list-before-create
            # reconciliation. A network timeout must never create a second project.
            project_name = "McpGo " + suffix
            project = self.resource(
                state, journal, admin, "project",
                "/organization/projects", "/organization/projects",
                project_name, {"name": project_name})
        elif not prior_project:
            projects = self.transport.projects(admin)
            usable = [row["id"] for row in projects]
            if project not in usable:
                raise RuntimeAdminError("Проект недоступен или это Default project. " +
                                        "Default не подходит для Service Accounts. " +
                                        "Выбери другой проект или разреши создать McpGo.")
        if journal.get("projectId") and journal["projectId"] != project:
            raise RuntimeAdminError("Настройка уже привязана к другому проекту. " +
                                    "Повторное создание остановлено.")
        journal["projectId"] = project
        if journal.pop("deferredPendingRole",False):
            journal["pending"] = "role"
        self.saved(state,journal)
        name = "McpGo Runtime " + suffix
        role_name = name
        role_kind = "role"
        if replace_invalid_role or journal.get("roleReplacementAuthorized"):
            # The old role might be used elsewhere. Never mutate or delete it:
            # instead create a uniquely named least-privilege replacement.
            # A fresh read must confirm the exact old role exists and is
            # unsuitable; do not create an unnecessary replacement.
            prior_roles = self.transport.list_rows(admin, "/organization/roles")
            old_matches = [r for r in prior_roles if r.get("name") == name]
            if len(old_matches) != 1:
                raise RuntimeAdminError("Не удалось однозначно подтвердить прежнюю роль. Нужна ручная сверка.")
            old_role = old_matches[0]
            if not isinstance(old_role.get("permissions"), list):
                raise RuntimeAdminError("OpenAI не вернул разрешения прежней роли.")
            if set(old_role["permissions"]) == set(RUNTIME_PERMISSIONS):
                if journal.get("roleReplacementAuthorized"):
                    # A replacement may already have been issued in a previous
                    # attempt. Retain the reconciliation path for that resource
                    # rather than switching identities mid-flight.
                    pass
                else:
                    # The user's earlier inspection was stale: organization role
                    # permissions can be visible after a delay. A fresh GET now
                    # proves the original role is least-privilege, so reuse it.
                    # Never create a replacement or block this valid recovery.
                    replace_invalid_role = False
            if replace_invalid_role or journal.get("roleReplacementAuthorized"):
                if not journal.get("roleReplacementAuthorized"):
                    # Explicit approval sent from SwiftUI after read-only inspection.
                    journal["roleReplacementAuthorized"] = True
                    if journal.get("pending") == "role":
                        journal["supersededPendingRole"] = True
                        journal["pending"] = None
                    self.saved(state, journal)
                role_name = name + " Restricted"
                role_kind = "replacement-role"
        role = self.resource(state, journal, admin, role_kind,
                             "/organization/roles", "/organization/roles",
                             role_name, {"role_name":role_name, "description":"McpGo tunnel runtime only",
                                    "permissions":list(RUNTIME_PERMISSIONS)},
                             permissions=RUNTIME_PERMISSIONS,
                             retry_missing_role=retry_role)
        if role_kind == "replacement-role":
            journal.setdefault("resources", {})["role"] = role
            self.saved(state, journal)
        group = self.resource(state, journal, admin, "group",
                              "/organization/groups", "/organization/groups",
                              name, {"name":name})
        self.assign(state, journal, admin, "role-assignment",
                    "/organization/groups/"+group+"/roles",
                    "/organization/groups/"+group+"/roles",
                    role, {"role_id":role})
        base = "/organization/projects/"+project+"/service_accounts"
        account = self.resource(state, journal, admin, "service-account",
                                base, base, name,
                                {"name":name, "create_service_account_only":True})
        self.assign(state, journal, admin, "account-membership",
                    "/organization/groups/"+group+"/users",
                    "/organization/groups/"+group+"/users",
                    account, {"user_id":account})

        # Persist pending BEFORE a non-idempotent key issuance. Its value is
        # available only once; a crash cannot safely be retried automatically.
        journal["status"] = "key-issuing"
        self.saved(state,journal)
        try:
            issued = self.transport.api(
                admin, "POST", base+"/"+account+"/api_keys",
                {"name":name, "scopes":list(RUNTIME_PERMISSIONS),
                 "expires_in_seconds": 7776000},  # 90 days; org policy may be tighter
            )
        except KnownRejection:
            journal["status"] = "ready-for-key"
            self.saved(state,journal)
            raise
        value = issued.get("value")
        key_id = issued.get("id")
        if not isinstance(value,str) or not value.startswith("sk-") or not isinstance(key_id,str):
            raise RuntimeAdminError("OpenAI не подтвердил созданный ключ. " +
                                    "Повторное создание заблокировано; воспользуйся ручным способом.")
        journal["status"] = "key-issued"
        journal["keyId"] = key_id
        self.saved(state,journal)
        return {"runtimeKey":value, "projectName":name,
                "message":"Ключ выдан для отдельного Service Account; сохраните в Keychain."}
