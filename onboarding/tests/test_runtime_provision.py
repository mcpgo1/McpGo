import json
import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from setup_engine import SetupEngine, SetupError
from runtime_provision import RuntimeAdminAPI, RuntimeAdminError, KnownRejection, RuntimeAutoProvisioner

TID1 = "tunnel_aaaaaaaaaaaaaaaaaaaaaaa"
TID2 = "tunnel_bbbbbbbbbbbbbbbbbbbbbbb"

class FakeAdmin(RuntimeAdminAPI):
    reconciliation_delays = (0.0,)

    def __init__(self):
        self.database = {
            "/organization/projects": [{"id":"proj_mock12345","name":"My workspace","status":"active"}],
            "/organization/roles":[],
            "/organization/groups":[],
            "/organization/projects/proj_mock12345/service_accounts":[]
        }
        self.calls = []
        self.counter = 0
        self.fail_on = None
        self.ambiguous_on = None

    def api(self, admin, method, path, payload=None):
        assert admin == "sk-admin-valid-fake"
        self.calls.append((method,path))
        if method == "GET":
            root=path.split("?")[0]
            return {"data":list(self.database.get(root,[])), "has_more":False}
        if method != "POST":
            raise AssertionError(method)
        if path == self.fail_on:
            raise KnownRejection("OpenAI denied access (403)")
        if path == self.ambiguous_on:
            raise RuntimeAdminError("Timeout")
        self.counter+=1
        value={"id":"test_resource_"+str(self.counter),"name":(payload or {}).get("name","")}
        if path == "/organization/projects":
            value["id"] = "proj_mockgenerated123"
            value["status"] = "active"
        if path == "/organization/roles":
            value["id"]="role_mockcreated"+str(self.counter)
            value["name"]=(payload or {})["role_name"]
            value["permissions"] = (payload or {})["permissions"]
            self.database[path].append(value)
        elif path.endswith("/api_keys"):
            value["value"]="sk-test-private-credential"
            value["id"]="key_test12345"
        elif path.endswith("/roles"):
            value={"role":{"id":payload["role_id"]}}
        elif path.endswith("/users"):
            value={"user_id":payload["user_id"]}
        else:
            self.database.setdefault(path,[]).append(value)
        return value

class RuntimeAutoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        path=Path(self.temp.name)
        self.engine=SetupEngine(path,path)
        state=self.engine.read_state()
        state["installationId"]="testinstall"
        state["tunnels"]={
            "terminal":{"id":TID1},
            "browser":{"id":TID2}
        }
        state["runtimeProvision"]={"suffix":"testinstall","projectId":"proj_mock12345"}
        self.engine.write_state(state)
        self.fake=FakeAdmin()
        self.service=RuntimeAutoProvisioner(self.engine,self.fake)
        self.request={"confirmed":True,"projectId":"proj_mock12345",
                      "adminKey":"sk-admin-valid-fake"}

    def test_default_project_not_usable_for_service_accounts(self):
        self.fake.database["/organization/projects"] = [
            {"id":"proj_defaultMock1","name":"Default project","status":"active"},
            {"id":"proj_defaultMock2","name":"Default","status":"active"},
            {"id":"proj_activeProject1","name":"Customer project","status":"active"},
            {"id":"proj_archivedMock1","name":"Archived","status":"archived"}]
        response = self.service.projects({"adminKey":"sk-admin-valid-fake"})
        self.assertEqual(response["projects"],[
            {"id":"proj_activeProject1","name":"Customer project"}])
        self.assertFalse(any(method == "POST" for method, _ in self.fake.calls))

    def test_default_only_can_create_mcpgo_project_after_confirmation(self):
        self.fake.database["/organization/projects"]=[
            {"id":"proj_defaultOnly123","name":"Default project","status":"active"}]
        self.engine.write_state({
            **self.engine.read_state(),
            "runtimeProvision":{"suffix":"testinstall"}})
        self.assertEqual(self.service.projects({"adminKey":"sk-admin-valid-fake"})["projects"],[])
        request={"confirmed":True,"createProject":True,"adminKey":"sk-admin-valid-fake"}
        result=self.service.provision(request)
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        calls=[(method,path) for method,path in self.fake.calls]
        self.assertEqual(calls.count(("POST","/organization/projects")),1)
        stored=self.engine.read_state()["runtimeProvision"]
        self.assertEqual(stored["projectId"],"proj_mockgenerated123")
        self.assertEqual(stored["projectMode"],"create")
        with self.assertRaisesRegex(RuntimeAdminError,"уже выпускался"):
            self.service.provision(request)
        self.assertEqual(calls.count(("POST","/organization/projects")),1)

    def test_project_creation_requires_confirmation(self):
        state=dict(self.engine.read_state())
        state["runtimeProvision"]={"suffix":"testinstall"}
        self.engine.write_state(state)
        for request in ({"createProject":True,"adminKey":"sk-admin-valid-fake"},
                        {"createProject":True,"confirmed":True,"adminKey":"sk-admin-valid-fake",
                         "projectId":"proj_mock12345"}):
            with self.assertRaises(RuntimeAdminError):
                self.service.provision(request)
        self.assertFalse(any(method=="POST" for method,_ in self.fake.calls))

    def test_uncertain_project_create_does_not_duplicate(self):
        state=dict(self.engine.read_state())
        state["runtimeProvision"]={"suffix":"testinstall"}
        self.engine.write_state(state)
        self.fake.ambiguous_on="/organization/projects"
        request={"confirmed":True,"createProject":True,"adminKey":"sk-admin-valid-fake"}
        with self.assertRaisesRegex(RuntimeAdminError,"Timeout"):
            self.service.provision(request)
        self.assertEqual(self.engine.read_state()["runtimeProvision"]["pending"],"project")
        self.fake.ambiguous_on=None
        with self.assertRaisesRegex(RuntimeAdminError,"не повторяет"):
            self.service.provision(request)
        self.assertEqual(sum(1 for m,path in self.fake.calls
                             if m=="POST" and path=="/organization/projects"),1)

    def test_reconciliation_finds_project_after_unknown_result(self):
        state=dict(self.engine.read_state())
        state["runtimeProvision"]={"suffix":"testinstall",
                                   "projectMode":"create","pending":"project"}
        self.engine.write_state(state)
        self.fake.database["/organization/projects"].append({
            "id":"proj_reconciled123","name":"McpGo testinstall","status":"active"})
        response=self.service.provision({
            "confirmed":True,"createProject":True,"adminKey":"sk-admin-valid-fake"})
        self.assertTrue(response["runtimeKey"].startswith("sk-"))
        self.assertEqual(self.engine.read_state()["runtimeProvision"]["projectId"],
                         "proj_reconciled123")
        self.assertFalse(any(m=="POST" and path=="/organization/projects"
                             for m,path in self.fake.calls))

    def test_cannot_target_default_project_as_existing(self):
        self.fake.database["/organization/projects"]=[
            {"id":"proj_defaultMock1","name":"Default project","status":"active"}]
        with self.assertRaisesRegex(RuntimeAdminError,"Прежний проект недоступен"):
            self.service.provision({"confirmed":True,"projectId":"proj_defaultMock1",
                                    "adminKey":"sk-admin-valid-fake"})
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall"}
        self.engine.write_state(state)
        with self.assertRaisesRegex(RuntimeAdminError,"Default"):
            self.service.provision({"confirmed":True,"projectId":"proj_defaultMock1",
                                    "adminKey":"sk-admin-valid-fake"})
        self.assertFalse(any(method=="POST" for method,_ in self.fake.calls))

    def test_recovery_inspection_is_read_only_and_flags_default(self):
        state = self.engine.read_state()
        state["runtimeProvision"] = {"suffix":"testinstall",
           "projectId":"proj_defaultMock1","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/projects"] = [
           {"id":"proj_defaultMock1","name":"Default project","status":"active"}]
        report=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
        self.assertTrue(report["priorProjectIsDefault"])
        self.assertEqual(report["pendingKind"],"role")
        self.assertFalse(report["roleFound"])
        self.assertFalse(any(m=="POST" for m,_ in self.fake.calls))

    def test_pending_role_found_is_reused_without_duplicate(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
             "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/roles"]=[{
             "id":"role_existing123",
             "name":"McpGo Runtime testinstall",
             "permissions":["api.organization.tunnel.read","api.organization.tunnel.use"]}]
        result=self.service.provision(self.request)
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        self.assertNotIn(("POST","/organization/roles"),self.fake.calls)

    def test_retry_pending_role_requires_explicit_confirmation_and_is_bounded(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
            "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        with self.assertRaisesRegex(RuntimeAdminError,"не повторяет"):
            self.service.provision(self.request)
        self.assertFalse(any(m=="POST" for m,_ in self.fake.calls))
        result=self.service.provision({**self.request,"retryMissingRole":True})
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        self.assertTrue(self.engine.read_state()["runtimeProvision"]["roleRetryUsed"])
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),1)

    def test_existing_default_migrates_only_with_explicit_approval(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
              "projectId":"proj_defaultMock1","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/projects"]=[
            {"id":"proj_defaultMock1","name":"Default project","status":"active"}]
        request={"confirmed":True,"adminKey":"sk-admin-valid-fake","createProject":True}
        with self.assertRaisesRegex(RuntimeAdminError,"Default project"):
            self.service.provision(request)
        self.assertFalse(any(m=="POST" for m,_ in self.fake.calls))
        result=self.service.provision({**request,"replaceDefaultProject":True,
                                      "retryMissingRole":True})
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        recorded=self.engine.read_state()["runtimeProvision"]
        self.assertEqual(recorded["projectId"],"proj_mockgenerated123")
        self.assertEqual(recorded["priorDefaultProject"],"proj_defaultMock1")
        self.assertEqual(self.fake.calls.count(("POST","/organization/projects")),1)
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),1)

    def test_success_without_id_reconciles_delayed_role_using_get_only(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
                                   "projectId":"proj_mock12345",
                                   "projectMode":"existing"}
        self.engine.write_state(state)
        original=self.fake.api
        self.fake.reconciliation_delays=(0.0, 0.0, 0.0)
        role_reads=0
        def delayed(admin, method, path, payload=None):
            nonlocal role_reads
            if method == "POST" and path == "/organization/roles":
                result=original(admin,method,path,payload)
                # Emulate an old/partial success envelope without an ID.
                return {"object":"acknowledged"}
            if method == "GET" and path.startswith("/organization/roles"):
                role_reads += 1
                if role_reads <= 2:
                    self.fake.calls.append((method,path))
                    return {"data":[],"has_more":False}
            return original(admin,method,path,payload)
        self.fake.api=delayed
        result=self.service.provision(self.request)
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),1)
        self.assertGreaterEqual(role_reads,3)

    def test_unknown_role_response_records_schema_but_never_payload_or_key(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
                                   "projectId":"proj_mock12345",
                                   "projectMode":"existing"}
        self.engine.write_state(state)
        source=self.fake.api
        def unknown(admin, method, path, payload=None):
            if method=="POST" and path=="/organization/roles":
                self.fake.calls.append((method,path))
                return {"object":"unrecognized", "error":{"message":"secret-field-value"},
                        "secret":"sensitive", "detail":{"token":"do-not-persist"}}
            return source(admin,method,path,payload)
        self.fake.api=unknown
        with self.assertRaisesRegex(RuntimeAdminError,"формату"):
            self.service.provision(self.request)
        state_text=self.engine.store.read_text()
        self.assertNotIn("secret-field-value",state_text)
        self.assertNotIn("sensitive",state_text)
        self.assertNotIn("do-not-persist",state_text)
        self.assertNotIn("sk-admin-valid-fake",state_text)
        journal=self.engine.read_state()["runtimeProvision"]
        self.assertEqual(journal["pending"],"role")
        diagnostic=journal["lastFailure"]
        self.assertEqual(diagnostic["operation"],"role")
        self.assertEqual(diagnostic["responseShape"]["idType"],"absent")
        self.assertTrue(diagnostic["responseShape"]["containsErrorField"])
        self.assertEqual(diagnostic["matchingNamesAfter"],0)
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),1)
        result=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
        self.assertEqual(result["lastFailure"],diagnostic)
        self.assertNotIn(("POST","/organization/projects"),self.fake.calls)

    def test_safe_response_shape_never_exposes_data_values(self):
        from runtime_provision import safe_response_shape
        result=safe_response_shape({"object":"role","id":"role_privateABC",
            "name":"Person Name", "secret":"sk-secret", "role":{
                "id":"role_otherPrivate","value":"sk-secret-key","name":"other"},
            "data":{"email":"private@example.com"}})
        text=json.dumps(result)
        for private in ("role_privateABC","role_otherPrivate","Person Name",
                        "sk-secret","private@example.com"):
            self.assertNotIn(private,text)
        self.assertEqual(result["idType"],"string")
        self.assertEqual(result["objectKind"],"role")
        self.assertEqual(result["nestedFields"],["id","name"])

    def test_role_without_id_reconciles_by_read_not_duplicate(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
             "projectId":"proj_mock12345","projectMode":"existing"}
        self.engine.write_state(state)
        original=self.fake.api
        def response_without_id(admin,method,path,payload=None):
            result=original(admin,method,path,payload)
            if method=="POST" and path=="/organization/roles":
                return {"object":"acknowledged"}
            return result
        self.fake.api=response_without_id
        result=self.service.provision(self.request)
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),1)

    def test_default_project_migration_does_not_erase_pending_role(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
              "projectId":"proj_defaultMock1","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/projects"]=[
            {"id":"proj_defaultMock1","name":"Default project","status":"active"}]
        request={"confirmed":True,"adminKey":"sk-admin-valid-fake",
                 "createProject":True,"replaceDefaultProject":True}
        with self.assertRaisesRegex(RuntimeAdminError,"не повторяет"):
            self.service.provision(request)
        journal=self.engine.read_state()["runtimeProvision"]
        self.assertEqual(journal["pending"],"role")
        self.assertEqual(journal["projectId"],"proj_mockgenerated123")
        self.assertEqual(self.fake.calls.count(("POST","/organization/projects")),1)
        self.assertNotIn(("POST","/organization/roles"),self.fake.calls)
        result=self.service.provision({**request,"retryMissingRole":True})
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        self.assertEqual(self.fake.calls.count(("POST","/organization/projects")),1)
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),1)

    def test_nested_role_response_is_supported(self):
        original=self.fake.api
        def nested(admin,method,path,payload=None):
            result=original(admin,method,path,payload)
            if method=="POST" and path=="/organization/roles":
                return {"role":result}
            return result
        self.fake.api=nested
        response=self.service.provision(self.request)
        self.assertTrue(response["runtimeKey"].startswith("sk-"))

    def test_replacement_role_requires_consent_preserves_original(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
           "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        original_role={"id":"role_wrong123","name":"McpGo Runtime testinstall",
                       "permissions":["api.organization.tunnel.write"]}
        self.fake.database["/organization/roles"]=[original_role]
        with self.assertRaisesRegex(RuntimeAdminError,"минимальным разрешениям"):
            self.service.provision(self.request)
        self.assertNotIn(("POST","/organization/roles"),self.fake.calls)
        result=self.service.provision({**self.request,"replaceInvalidRole":True})
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        journal=self.engine.read_state()["runtimeProvision"]
        self.assertTrue(journal.get("roleReplacementAuthorized"))
        self.assertTrue(journal.get("supersededPendingRole"))
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),1)
        self.assertIn(original_role,self.fake.database["/organization/roles"])
        replacement=[x for x in self.fake.database["/organization/roles"]
                     if x.get("name")=="McpGo Runtime testinstall Restricted"]
        self.assertEqual(len(replacement),1)
        self.assertEqual(set(replacement[0]["permissions"]),
                         {"api.organization.tunnel.read","api.organization.tunnel.use"})

    def test_user_screenshot_default_project_and_invalid_role_recovered_together(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
           "projectId":"proj_defaultMock1","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/projects"]=[
            {"id":"proj_defaultMock1","name":"Default project","status":"active"}]
        self.fake.database["/organization/roles"]=[{
            "id":"role_wrong123","name":"McpGo Runtime testinstall",
            "permissions":["api.organization.tunnel.write"]}]
        inspection=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
        self.assertTrue(inspection["priorProjectIsDefault"])
        self.assertTrue(inspection["roleFound"])
        self.assertFalse(inspection["roleValid"])
        self.assertFalse(any(method=="POST" for method, _ in self.fake.calls))
        req={"confirmed":True,"createProject":True,"adminKey":"sk-admin-valid-fake",
             "replaceDefaultProject":True,"replaceInvalidRole":True}
        result=self.service.provision(req)
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        self.assertEqual(self.fake.calls.count(("POST","/organization/projects")),1)
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),1)
        self.assertIn("role_wrong123",
          [r["id"] for r in self.fake.database["/organization/roles"]])
        self.assertEqual(self.engine.read_state()["runtimeProvision"]["projectId"],
                         "proj_mockgenerated123")
        with self.assertRaisesRegex(RuntimeAdminError,"уже выпускался"):
            self.service.provision(req)

    def test_stale_replacement_consent_reuses_newly_valid_original_role(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
            "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        previous={"id":"role_validexisting123",
                  "name":"McpGo Runtime testinstall",
                  "permissions":["api.organization.tunnel.read",
                                 "api.organization.tunnel.use"]}
        self.fake.database["/organization/roles"]=[previous]
        # UI obtained a stale "wrong permissions" result and the user
        # consented to a replacement, but OpenAI now returns the correct role.
        response=self.service.provision({
            **self.request, "replaceInvalidRole":True})
        self.assertTrue(response["runtimeKey"].startswith("sk-"))
        journal=self.engine.read_state()["runtimeProvision"]
        self.assertEqual(journal["resources"]["role"],previous["id"])
        self.assertNotIn("roleReplacementAuthorized",journal)
        self.assertNotIn("replacement-role",journal["resources"])
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),0)

    def test_inspect_stale_permissions_then_use_existing_project(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
             "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        current_role={"id":"role_recoveredExisting",
            "name":"McpGo Runtime testinstall",
            "permissions":["api.organization.tunnel.read"]}
        self.fake.database["/organization/roles"]=[current_role]
        inspection=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
        self.assertTrue(inspection["roleFound"])
        self.assertFalse(inspection["roleValid"])
        # The permissions finish propagating before the user presses Continue.
        current_role["permissions"]=["api.organization.tunnel.read",
                                     "api.organization.tunnel.use"]
        response=self.service.provision({**self.request,"replaceInvalidRole":True})
        self.assertTrue(response["runtimeKey"].startswith("sk-"))
        journal=self.engine.read_state()["runtimeProvision"]
        self.assertEqual(journal["resources"]["role"],"role_recoveredExisting")
        self.assertEqual(journal["projectId"],"proj_mock12345")
        self.assertNotIn(("POST","/organization/roles"),self.fake.calls)
        self.assertNotIn(("POST","/organization/projects"),self.fake.calls)

    def test_replacement_unknown_response_is_not_retried(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
           "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/roles"]=[{
            "id":"role_wrong123","name":"McpGo Runtime testinstall",
            "permissions":["api.organization.tunnel.write"]}]
        self.fake.ambiguous_on="/organization/roles"
        request={**self.request,"replaceInvalidRole":True}
        with self.assertRaisesRegex(RuntimeAdminError,"Timeout"):
            self.service.provision(request)
        journal=self.engine.read_state()["runtimeProvision"]
        self.assertEqual(journal["pending"],"replacement-role")
        self.assertTrue(journal["roleReplacementAuthorized"])
        self.fake.ambiguous_on=None
        with self.assertRaisesRegex(RuntimeAdminError,"не повторяет"):
            self.service.provision(request)
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),1)

    def test_permissions_correct_but_id_missing_is_not_misreported_as_bad_permissions(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
             "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/roles"]=[{
            "name":"McpGo Runtime testinstall",
            "object":"role",
            "permissions":["api.organization.tunnel.read","api.organization.tunnel.use"]}]
        result=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
        self.assertTrue(result["roleFound"])
        self.assertTrue(result["rolePermissionsValid"])
        self.assertFalse(result["roleHasValidID"])
        self.assertFalse(result["roleValid"])
        self.assertEqual(result["roleMissingPermissions"],[])
        self.assertEqual(result["roleUnexpectedPermissions"],[])
        self.assertEqual(result["roleResponseShape"]["idType"],"absent")
        self.assertFalse(any(m=="POST" for m,_ in self.fake.calls))

    def test_matching_role_without_id_never_creates_duplicate(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
             "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/roles"]=[{
            "object":"role","name":"McpGo Runtime testinstall",
            "permissions":["api.organization.tunnel.read","api.organization.tunnel.use"]}]
        with self.assertRaisesRegex(RuntimeAdminError,"ID"):
            self.service.provision(self.request)
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),0)
        status=self.engine.read_state()["runtimeProvision"]
        self.assertEqual(status["pending"],"role")
        self.assertEqual(status["lastFailure"]["source"],"read")
        self.assertIsNone(status["lastFailure"]["httpStatus"])
        self.assertEqual(status["lastFailure"]["responseShape"]["idType"],"absent")

    def test_compatible_role_id_field_resolves_only_when_name_and_permissions_match(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
             "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/roles"]=[{
            "role_id":"role_noncanonical12345",
            "name":"McpGo Runtime testinstall",
            "permissions":["api.organization.tunnel.read","api.organization.tunnel.use"]}]
        report=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
        self.assertTrue(report["roleHasValidID"])
        self.assertTrue(report["roleValid"])
        result=self.service.provision(self.request)
        self.assertTrue(result["runtimeKey"].startswith("sk-"))
        self.assertEqual(self.engine.read_state()["runtimeProvision"]["resources"]["role"],
                         "role_noncanonical12345")
        self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),0)

    def test_diagnostic_displays_actual_role_id_and_precise_rejection_reason(self):
        from runtime_provision import role_id_diagnostic
        for resource_type, expected_reason in (
                ("api.organization","accepted"),
                ("api.project","wrong_resource_type"),
                ("unexpected.scope","wrong_resource_type")):
            role={"object":"role","id":"r.987:xyz+label",
                  "resource_type":resource_type,"name":"McpGo Runtime testinstall",
                  "permissions":["api.organization.tunnel.read",
                                 "api.organization.tunnel.use"]}
            report=role_id_diagnostic(role)
            self.assertEqual(report["id"],"r.987:xyz+label")
            self.assertEqual(report["resourceType"],resource_type)
            self.assertEqual(report["reason"],expected_reason)
            self.assertEqual(report["accepted"],expected_reason=="accepted")
            self.assertNotIn("permissions",report)

    def test_read_only_inspection_exposes_role_id_only_in_ephemeral_result(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
            "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        role={"id":"01J1F8_ROLE:unusual","object":"role","resource_type":"api.project",
              "name":"McpGo Runtime testinstall",
              "permissions":["api.organization.tunnel.read","api.organization.tunnel.use"]}
        self.fake.database["/organization/roles"]=[role]
        result=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
        self.assertEqual(result["roleIDDiagnostic"]["id"],role["id"])
        self.assertEqual(result["roleIDDiagnostic"]["reason"],"wrong_resource_type")
        self.assertFalse(result["roleValid"])
        self.assertTrue(result["rolePermissionsValid"])
        self.assertFalse(any(m=="POST" for m,_ in self.fake.calls))
        state_text=self.engine.store.read_text()
        self.assertNotIn(role["id"],state_text)
        self.assertNotIn("sk-admin-valid-fake",state_text)

    def test_role_id_is_opaque_not_forced_to_role_prefix(self):
        # The published OpenAI schema says 'id: string'; the role_ value is
        # only an example. Opaque IDs may start with digits or other prefixes.
        from runtime_provision import valid_role_id
        for identifier in ("role_01J1F8ROLE01", "01J1F8ROLE01", "9d4a6f77-11ab",
                           "orgrole-1234", "r_abcd123"):
            with self.subTest(kind=identifier[:2]):
                row={"object":"role", "id":identifier,
                     "resource_type":"api.organization",
                     "name":"McpGo Runtime testinstall",
                     "permissions":["api.organization.tunnel.read",
                                    "api.organization.tunnel.use"]}
                self.assertEqual(valid_role_id(row),identifier)
                state=self.engine.read_state()
                state["runtimeProvision"]={"suffix":"testinstall",
                    "projectId":"proj_mock12345","projectMode":"existing",
                    "pending":"role"}
                self.engine.write_state(state)
                self.fake.database["/organization/roles"]=[row]
                report=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
                self.assertTrue(report["roleValid"])
                self.assertTrue(report["roleHasValidID"])
                self.assertTrue(report["rolePermissionsValid"])
                result=self.service.provision(self.request)
                self.assertTrue(result["runtimeKey"].startswith("sk-"))
                self.assertEqual(self.engine.read_state()["runtimeProvision"]
                                 ["resources"]["role"],identifier)
                self.assertEqual(self.fake.calls.count(("POST","/organization/roles")),0)
                self.fake=FakeAdmin()
                self.service=RuntimeAutoProvisioner(self.engine,self.fake)

    def test_reject_unsafe_or_wrong_role_identifiers(self):
        from runtime_provision import valid_role_id
        for identifier in ("", "r", "../role", "/root", "123/cmd", "role_abc\\nBAD",
                           "abc def", "роль_12345", "a"*400):
            self.assertIsNone(valid_role_id({"object":"role", "id":identifier,
                                              "resource_type":"api.organization"}))
        self.assertIsNone(valid_role_id({"object":"project", "id":"01J1F8ROLE01"}))
        self.assertIsNone(valid_role_id({"object":"role", "id":"01J1F8ROLE01",
                                          "resource_type":"api.project"}))

    def test_inspection_returns_public_permission_diff_only(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
           "projectId":"proj_mock12345","projectMode":"existing","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/roles"]=[{
            "id":"role_wrong123","name":"McpGo Runtime testinstall",
            "permissions":["api.organization.tunnel.write","api.organization.tunnel.read"]}]
        report=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
        self.assertTrue(report["roleFound"])
        self.assertFalse(report["roleValid"])
        self.assertEqual(report["roleMissingPermissions"],["api.organization.tunnel.use"])
        self.assertEqual(report["roleUnexpectedPermissions"],["api.organization.tunnel.write"])
        self.assertEqual(report["roleIDDiagnostic"]["id"],"role_wrong123")
        self.assertNotIn("sk-admin-valid-fake",str(report))
        self.assertFalse(any(m=="POST" for m,_ in self.fake.calls))

    def test_role_inspect_rejects_incorrect_permissions_without_mutation(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={"suffix":"testinstall",
                                   "projectId":"proj_mock12345","pending":"role"}
        self.engine.write_state(state)
        self.fake.database["/organization/roles"].append({
            "id":"role_existing_bad",
            "name":"McpGo Runtime testinstall",
            "permissions":["api.organization.tunnel.write"]})
        result=self.service.inspect({"adminKey":"sk-admin-valid-fake"})
        self.assertTrue(result["roleFound"])
        self.assertFalse(result["roleValid"])
        self.assertFalse(any(method=="POST" for method,_ in self.fake.calls))

    def test_key_uses_documented_scopes_field_plural_for_http_api(self):
        original=self.fake.api
        issued_payload=[]
        def capture(admin,method,path,payload=None):
            if method=="POST" and path.endswith("/api_keys"):
                issued_payload.append(payload)
            return original(admin,method,path,payload)
        self.fake.api=capture
        self.service.provision(self.request)
        self.assertEqual(len(issued_payload),1)
        self.assertIn("scopes",issued_payload[0])
        self.assertNotIn("scope",issued_payload[0])
        self.assertEqual(set(issued_payload[0]["scopes"]),
             {"api.organization.tunnel.read","api.organization.tunnel.use"})

    def seed_ambiguous_key_issue(self):
        state=self.engine.read_state()
        state["runtimeProvision"]={
            "suffix":"testinstall","projectId":"proj_mock12345",
            "projectMode":"existing","status":"key-issuing",
            "resources":{
                "role":"role_existing123","group":"group_existing123",
                "role-assignment":"assigned","service-account":"sa_existing123",
                "account-membership":"assigned",
            }
        }
        self.engine.write_state(state)
        self.fake.database["/organization/projects/proj_mock12345/service_accounts"]=[
            {"id":"sa_existing123","name":"McpGo Runtime testinstall"}]
        self.fake.database["/organization/projects/proj_mock12345/api_keys"]=[
            {"id":"key_old123","name":"McpGo Runtime testinstall",
             "owner":{"type":"service_account",
                      "service_account":{"id":"sa_existing123"}}},
            {"id":"key_other","name":"Someone else",
             "owner":{"type":"user","user":{"id":"user_1"}}}
        ]

    def test_key_inspection_only_reads_own_service_account_metadata(self):
        self.seed_ambiguous_key_issue()
        found=self.service.inspect({"adminKey":self.request["adminKey"]})
        self.assertEqual(found["keyIssuanceStatus"],"key-issuing")
        self.assertTrue(found["serviceAccountReady"])
        self.assertTrue(found["serviceAccountKeyInventoryChecked"])
        self.assertEqual(found["serviceAccountKeyCount"],1)
        self.assertFalse(any(method=="POST" for method,_ in self.fake.calls))

    def test_recovery_issues_one_key_without_recreating_any_resource(self):
        self.seed_ambiguous_key_issue()
        req={"adminKey":self.request["adminKey"],"confirmed":True,
             "acknowledgePossiblePreviousKey":True}
        with self.assertRaises(RuntimeAdminError):
            self.service.recover_key({"adminKey":self.request["adminKey"]})
        self.assertFalse(any(method=="POST" for method,_ in self.fake.calls))
        response=self.service.recover_key(req)
        self.assertTrue(response["runtimeKey"])
        journal=self.engine.read_state()["runtimeProvision"]
        self.assertEqual(journal["status"],"key-issued")
        self.assertTrue(journal["keyRecoveryAttempted"])
        self.assertEqual(journal["resources"]["service-account"],"sa_existing123")
        self.assertNotIn(response["runtimeKey"],self.engine.store.read_text())
        changes=[path for method,path in self.fake.calls if method=="POST"]
        self.assertEqual(changes,[
            "/organization/projects/proj_mock12345/service_accounts/sa_existing123/api_keys"])
        with self.assertRaises(RuntimeAdminError):
            self.service.recover_key(req)
        self.assertEqual(sum(1 for method,_ in self.fake.calls if method=="POST"),1)

    def test_lost_key_after_success_can_be_reissued_once(self):
        self.seed_ambiguous_key_issue()
        state=self.engine.read_state()
        state["runtimeProvision"]["status"]="key-issued"
        state["runtimeProvision"]["keyId"]="key_original123"
        self.engine.write_state(state)
        response=self.service.recover_key({
            "adminKey":self.request["adminKey"],
            "confirmed":True,"acknowledgePossiblePreviousKey":True})
        self.assertTrue(response["runtimeKey"])
        self.assertTrue(self.engine.read_state()["runtimeProvision"]["keyRecoveryAttempted"])

    def test_recovery_requires_confirmed_existing_account(self):
        self.seed_ambiguous_key_issue()
        state=self.engine.read_state()
        del state["runtimeProvision"]["resources"]["group"]
        self.engine.write_state(state)
        payload={"adminKey":self.request["adminKey"],"confirmed":True,
                 "acknowledgePossiblePreviousKey":True}
        with self.assertRaises(RuntimeAdminError):
            self.service.recover_key(payload)
        self.assertFalse(any(method=="POST" for method,_ in self.fake.calls))
        state["runtimeProvision"]["resources"]["group"]="group_existing123"
        self.engine.write_state(state)
        self.fake.database["/organization/projects/proj_mock12345/service_accounts"]=[]
        with self.assertRaises(RuntimeAdminError):
            self.service.recover_key(payload)
        self.assertFalse(any(method=="POST" for method,_ in self.fake.calls))

    def test_recovery_ambiguous_result_never_retries_post(self):
        self.seed_ambiguous_key_issue()
        path="/organization/projects/proj_mock12345/service_accounts/sa_existing123/api_keys"
        self.fake.ambiguous_on=path
        req={"adminKey":self.request["adminKey"],"confirmed":True,
             "acknowledgePossiblePreviousKey":True}
        with self.assertRaises(RuntimeAdminError):
            self.service.recover_key(req)
        self.assertEqual(self.engine.read_state()["runtimeProvision"]["status"],
                         "recovery-key-issuing")
        self.fake.ambiguous_on=None
        with self.assertRaises(RuntimeAdminError):
            self.service.recover_key(req)
        self.assertEqual(self.fake.calls.count(("POST",path)),1)

    def test_projects_are_read_only(self):
        projects=self.service.projects({"adminKey":"sk-admin-valid-fake"})
        self.assertEqual(projects["projects"][0]["id"],"proj_mock12345")
        self.assertFalse(any(method=="POST" for method, _ in self.fake.calls))

    def test_requires_consent_and_project_in_scope(self):
        for data in ({}, {"projectId":"proj_mock12345","adminKey":"sk-admin-valid-fake"},
                     {"confirmed":True,"projectId":"proj_invalid","adminKey":"sk-admin-valid-fake"}):
            with self.assertRaises(RuntimeAdminError):
                self.service.provision(data)
        self.assertFalse(any(m=="POST" for m,_ in self.fake.calls))

    def test_issues_scoped_key_with_separate_role_group_and_account(self):
        response=self.service.provision(self.request)
        self.assertEqual(response["runtimeKey"],"sk-test-private-credential")
        self.assertTrue(self.engine.read_state()["runtimeProvision"]["status"]=="key-issued")
        state_text=self.engine.store.read_text()
        self.assertNotIn("sk-admin",state_text)
        self.assertNotIn("sk-test-private-credential",state_text)
        self.assertEqual(self.engine.store.stat().st_mode & 0o077,0)
        self.assertEqual(len([call for call in self.fake.calls if call[0]=="POST"]),6)
        self.assertEqual(self.fake.database["/organization/roles"][0]["permissions"],
                         ["api.organization.tunnel.read","api.organization.tunnel.use"])
        with self.assertRaisesRegex(RuntimeAdminError,"уже выпускался"):
            self.service.provision(self.request)
        self.assertEqual(len([call for call in self.fake.calls if call[0]=="POST"]),6)

    def test_known_rejection_allows_only_explicit_retry(self):
        self.fake.fail_on="/organization/roles"
        with self.assertRaises(KnownRejection):
            self.service.provision(self.request)
        self.assertIsNone(self.engine.read_state()["runtimeProvision"].get("pending"))
        self.fake.fail_on=None
        response=self.service.provision(self.request)
        self.assertTrue(response["runtimeKey"].startswith("sk-"))

    def test_ambiguous_response_refuses_duplicate_resource(self):
        self.fake.ambiguous_on="/organization/roles"
        with self.assertRaisesRegex(RuntimeAdminError,"Timeout"):
            self.service.provision(self.request)
        self.assertEqual(self.engine.read_state()["runtimeProvision"]["pending"],"role")
        self.fake.ambiguous_on=None
        with self.assertRaisesRegex(RuntimeAdminError,"не повторяет"):
            self.service.provision(self.request)
        self.assertEqual(len([x for x in self.fake.calls if x==("POST","/organization/roles")]),1)

    def test_reconciles_existing_group_role_from_top_level_role_id(self):
        self.fake.database["/organization/roles"]=[{
            "id":"role_mockexisting", "name":"McpGo Runtime testinstall",
            "permissions":["api.organization.tunnel.read","api.organization.tunnel.use"]}]
        self.fake.database["/organization/groups"]=[{
            "id":"group_mockexisting", "name":"McpGo Runtime testinstall"}]
        self.fake.database["/organization/groups/group_mockexisting/roles"]=[
            {"id":"role_mockexisting","permissions":["api.organization.tunnel.read",
                                                     "api.organization.tunnel.use"]}]
        self.service.provision(self.request)
        calls=[(method,path) for method,path in self.fake.calls if method=="POST"]
        self.assertNotIn(("POST","/organization/roles"),calls)
        self.assertNotIn(("POST","/organization/groups"),calls)
        self.assertNotIn(("POST","/organization/groups/group_mockexisting/roles"),calls)

    def test_existing_role_has_to_be_exact_least_privilege(self):
        self.fake.database["/organization/roles"]=[{
            "id":"role_abc123", "name":"McpGo Runtime testinstall",
            "permissions":["api.organization.tunnel.read","api.organization.tunnel.write"]}]
        with self.assertRaisesRegex(RuntimeAdminError,"минимальным разрешениям"):
            self.service.provision(self.request)
        self.assertFalse(any(m=="POST" for m,_ in self.fake.calls))

    def test_issued_key_unknown_is_never_repeated(self):
        path="/organization/projects/proj_mock12345/service_accounts/test_resource_4/api_keys"
        # account id is #4: role, group, group-role, then account
        self.fake.ambiguous_on=path
        with self.assertRaises(RuntimeAdminError):
            self.service.provision(self.request)
        self.assertEqual(self.engine.read_state()["runtimeProvision"]["status"],"key-issuing")
        self.fake.ambiguous_on=None
        with self.assertRaisesRegex(RuntimeAdminError,"уже выпускался"):
            self.service.provision(self.request)

if __name__=="__main__":
    unittest.main()
