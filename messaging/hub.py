#!/usr/bin/env python3
"""Local, opt-in message exchange for individually created ChatGPT conversations.
No ChatGPT transcript access or message injection. Uses SQLite and loopback HTTP.
"""
import argparse
import datetime
import json
import os
import re
import sqlite3
import sys
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('MCPHUB_MESSAGE_DB', str(Path.home() / 'Library/Application Support/McpGo/Messaging/messages.sqlite3')))
PORT = 8971
NAME = re.compile(r'^[A-Za-z][A-Za-z0-9_-]{0,31}$')
MAX_MESSAGE = 16000


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def connect():
    DATA.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if DATA.is_symlink() or DATA.parent.is_symlink():
        raise ValueError('Refusing symlink database')
    conn = sqlite3.connect(str(DATA), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA busy_timeout=5000')
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'agent' CHECK(role IN ('agent','orchestrator','hub')),
      chat_url TEXT NOT NULL DEFAULT '',
      last_report TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL REFERENCES agents(id),
      recipient TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message' CHECK(kind IN ('message','report')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(recipient,id);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(sender,id);
    CREATE TABLE IF NOT EXISTS reads (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      reader TEXT NOT NULL REFERENCES agents(id),
      read_at TEXT NOT NULL,
      PRIMARY KEY(message_id,reader)
    );''')
    # Non-destructive schema migration for already registered agents and messages.
    existing = {r[1] for r in conn.execute('PRAGMA table_info(agents)')}
    if 'archived_at' not in existing:
        conn.execute("ALTER TABLE agents ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''")
    if 'replaced_by' not in existing:
        conn.execute("ALTER TABLE agents ADD COLUMN replaced_by TEXT NOT NULL DEFAULT ''")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS only_one_active_orchestrator ON agents(role) WHERE role='orchestrator' AND archived_at=''")
    conn.execute("INSERT OR IGNORE INTO agents (id,label,role,created_at,last_seen) VALUES ('hub','MCP Hub','hub',?,?)", (now(),now()))
    conn.commit()
    if DATA.exists():
        os.chmod(DATA, 0o600)
    return conn


@contextmanager
def database():
    conn = connect()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def check_id(value):
    if not isinstance(value, str) or not NAME.fullmatch(value) or value.lower() == 'hub':
        raise ValueError('Agent ID must start with a letter, then up to 31 letters, digits, - or _; hub is reserved')
    return value


def exists(conn, aid):
    row=conn.execute('SELECT * FROM agents WHERE id=?',(aid,)).fetchone()
    if row is None: raise ValueError('Unknown agent: '+str(aid))
    return row


def rows(query): return [dict(x) for x in query.fetchall()]

def active(conn, aid):
    row = exists(conn,aid)
    if row['archived_at']:
        raise ValueError('Agent is archived: '+aid+'. Restore or replace it in MCP Hub.')
    return row


def validate_new_agent(conn, aid, label, role='agent', url=''):
    aid=check_id(aid)
    if role not in ('agent','orchestrator'):raise ValueError('Invalid role')
    if not isinstance(label,str) or not (1 <= len(label.strip()) <= 90):raise ValueError('Invalid display name')
    if not isinstance(url,str) or len(url)>500 or (url and (not url.startswith('https://chatgpt.com/') or '\n' in url)):
        raise ValueError('Chat URL must be an optional https://chatgpt.com/... link')
    if conn.execute('SELECT 1 FROM agents WHERE id=?',(aid,)).fetchone():
        raise ValueError('Agent ID already registered. Archived IDs are reserved to preserve history.')
    return aid,label.strip(),role,url


def set_role(conn, aid, role):
    aid=check_id(aid)
    active(conn,aid)
    if role not in ('agent','orchestrator'):
        raise ValueError('Invalid role')
    if role=='orchestrator':
        # Transactional handoff: old orchestrator becomes a regular agent.
        conn.execute("UPDATE agents SET role='agent' WHERE role='orchestrator' AND archived_at=''")
    conn.execute('UPDATE agents SET role=? WHERE id=?',(role,aid))
    conn.commit()
    return dict(active(conn,aid))


def archive_agent(conn, aid):
    aid=check_id(aid)
    active(conn,aid)
    conn.execute("UPDATE agents SET archived_at=?,role='agent' WHERE id=?",(now(),aid))
    conn.commit()
    return dict(exists(conn,aid))


def restore_agent(conn, aid):
    aid=check_id(aid)
    row=exists(conn,aid)
    if not row['archived_at']:
        raise ValueError('Agent is already active')
    conn.execute("UPDATE agents SET archived_at='',replaced_by='' WHERE id=?",(aid,))
    conn.commit()
    return dict(active(conn,aid))


def replace_agent(conn, old_id, new_id, label, url=''):
    old_id=check_id(old_id)
    old=active(conn,old_id)
    new_id,label,_,url=validate_new_agent(conn,new_id,label,'agent',url)
    if new_id==old_id:raise ValueError('New chat needs a different agent ID')
    # Atomic lifecycle transition; keep old messages in history and deliver
    # previously unread direct messages to the new conversation as handoff copies.
    conn.execute("INSERT INTO agents(id,label,role,chat_url,created_at,last_seen) VALUES (?,?,?,?,?,?)",
                 (new_id,label,'agent',url,now(),now()))
    conn.execute("UPDATE agents SET role='agent',archived_at=?,replaced_by=? WHERE id=?",(now(),new_id,old_id))
    if old['role']=='orchestrator':
        conn.execute("UPDATE agents SET role='orchestrator' WHERE id=?",(new_id,))
    pending=conn.execute("""SELECT id,sender,body FROM messages m
          WHERE m.recipient=? AND NOT EXISTS
            (SELECT 1 FROM reads r WHERE r.message_id=m.id AND r.reader=?)
          ORDER BY m.id""",(old_id,old_id)).fetchall()
    for original in pending:
        header=f"Передано от {old_id} (сообщение #{original['id']}, отправитель {original['sender']}):\n"
        body=(header+original['body'])[:MAX_MESSAGE]
        conn.execute('INSERT INTO messages(sender,recipient,kind,body,created_at) VALUES (?,?,?,?,?)',
                     ('hub',new_id,'message',body,now()))
    if old['last_report']:
        conn.execute('INSERT INTO messages(sender,recipient,kind,body,created_at) VALUES (?,?,?,?,?)',
                     ('hub',new_id,'message',f"Последний отчёт предыдущего чата {old_id}:\n"+old['last_report'][:MAX_MESSAGE-100],now()))
    conn.commit()
    return {'agent':dict(active(conn,new_id)),'archived':old_id,'forwarded':len(pending)}


def delete_agent(conn, aid, confirmation):
    aid=check_id(aid)
    if confirmation!=aid:raise ValueError('Confirmation must exactly match agent ID')
    row=exists(conn,aid)
    if not row['archived_at']:raise ValueError('Archive the agent before permanent deletion')
    count=conn.execute('SELECT count(*) FROM messages WHERE sender=? OR recipient=?',(aid,aid)).fetchone()[0]
    conn.execute('DELETE FROM messages WHERE sender=? OR recipient=?',(aid,aid))
    conn.execute('DELETE FROM reads WHERE reader=?',(aid,))
    conn.execute('DELETE FROM agents WHERE id=?',(aid,))
    conn.commit()
    return {'deleted':aid,'deleted_messages':count}


def register(conn, aid, label, role='agent', url=''):
    aid,label,role,url=validate_new_agent(conn,aid,label,role,url)
    if role=='orchestrator' and conn.execute("SELECT 1 FROM agents WHERE role='orchestrator' AND archived_at='' ").fetchone():
        raise ValueError('An orchestrator already exists. Change its role in MCP Hub first.')
    conn.execute('INSERT INTO agents(id,label,role,chat_url,created_at,last_seen) VALUES (?,?,?,?,?,?)',
                 (aid,label,role,url,now(),now()))
    conn.commit()
    return dict(exists(conn,aid))


def list_agents(conn, archived=False):
    condition="archived_at!=''" if archived else "archived_at=''"
    result=rows(conn.execute("SELECT id,label,role,chat_url,last_report,created_at,last_seen,archived_at,replaced_by FROM agents WHERE id!='hub' AND "+condition+" ORDER BY CASE role WHEN 'orchestrator' THEN 0 ELSE 1 END,label"))
    for agent in result:
        agent['unread']=conn.execute("SELECT COUNT(*) FROM messages m WHERE (m.recipient=? OR (m.recipient='*' AND m.sender!=?)) AND NOT EXISTS (SELECT 1 FROM reads r WHERE r.message_id=m.id AND r.reader=?)",(agent['id'],agent['id'],agent['id'])).fetchone()[0] if not archived else 0
    return result


def change_orchestrator(conn, aid):
    return set_role(conn,aid,'orchestrator')


def send(conn, sender, recipient, text, kind='message'):
    if sender != 'hub': check_id(sender)
    active(conn,sender) if sender!='hub' else exists(conn,sender)
    if recipient != '*':
        check_id(recipient);active(conn,recipient)
    if sender==recipient: raise ValueError('Cannot send to self')
    if not isinstance(text,str) or not text.strip() or len(text)>MAX_MESSAGE: raise ValueError('Message must be 1–16000 characters')
    if kind not in ('message','report'): raise ValueError('Unsupported kind')
    if kind=='report':
        owner=conn.execute("SELECT id FROM agents WHERE role='orchestrator' AND archived_at=''").fetchone()
        if owner is None: raise ValueError('Orchestrator not configured')
        recipient=owner['id']
    cur=conn.execute('INSERT INTO messages(sender,recipient,kind,body,created_at) VALUES (?,?,?,?,?)',
                     (sender,recipient,kind,text.strip(),now()))
    if sender!='hub':
        conn.execute('UPDATE agents SET last_seen=? WHERE id=?',(now(),sender))
    if kind=='report':
        conn.execute('UPDATE agents SET last_report=? WHERE id=?',(text.strip()[:2000],sender))
    conn.commit()
    return dict(conn.execute('SELECT * FROM messages WHERE id=?',(cur.lastrowid,)).fetchone())


def visible_condition(viewer, role):
    if role=='orchestrator' or role=='hub': return ('1=1',[])
    return ('(m.sender=? OR m.recipient=? OR (m.recipient=\'*\' AND m.sender!=?))',[viewer,viewer,viewer])


def history(conn, viewer='hub', agent='', limit=100, unread=False):
    owner=exists(conn,viewer) if viewer=='hub' else active(conn,viewer)
    condition,args=visible_condition(viewer,owner['role'])
    if agent:
        check_id(agent);exists(conn,agent)
        if viewer!='hub' and owner['role']!='orchestrator' and viewer!=agent:
            raise ValueError('Regular agents cannot read other agents’ history')
        condition+=' AND (m.sender=? OR m.recipient=?)';args.extend([agent,agent])
    if unread:
        if viewer=='hub': raise ValueError('Use an agent inbox to see unread messages')
        condition+=' AND (m.recipient=? OR (m.recipient=\'*\' AND m.sender!=?)) AND NOT EXISTS (SELECT 1 FROM reads r WHERE r.message_id=m.id AND r.reader=?)'
        args.extend([viewer,viewer,viewer])
    limit=max(1,min(int(limit),300))
    args.append(limit)
    results=rows(conn.execute('SELECT m.*, (SELECT r.read_at FROM reads r WHERE r.message_id=m.id AND r.reader=?) AS read_at FROM messages m WHERE '+condition+' ORDER BY m.id DESC LIMIT ?', [viewer]+args))
    return list(reversed(results))


def inbox(conn, viewer, limit=80):
    if viewer=='hub':raise ValueError('Inbox belongs to a registered agent')
    return history(conn,viewer,limit=limit,unread=True)


def mark_read(conn, viewer, ids):
    if viewer=='hub': raise ValueError('Hub cannot acknowledge agent messages')
    active(conn,viewer)
    if not isinstance(ids,list) or len(ids)>300 or not all(isinstance(i,int) and i>0 for i in ids):
        raise ValueError('Expected a list of message IDs')
    result=[]
    for mid in ids:
        row=conn.execute('SELECT * FROM messages WHERE id=?',(mid,)).fetchone()
        if not row or not (row['recipient']==viewer or (row['recipient']=='*' and row['sender']!=viewer)):
            raise ValueError('Message not addressed to this agent: '+str(mid))
        conn.execute('INSERT OR IGNORE INTO reads(message_id,reader,read_at) VALUES (?,?,?)',(mid,viewer,now()))
        result.append(mid)
    conn.execute('UPDATE agents SET last_seen=? WHERE id=?',(now(),viewer))
    conn.commit()
    return {'acknowledged':result}


def stats(conn):
    return {'agents':conn.execute("SELECT count(*) FROM agents WHERE id!='hub' AND archived_at=''").fetchone()[0],
            'messages':conn.execute('SELECT count(*) FROM messages').fetchone()[0],
            'orchestrator':(conn.execute("SELECT id FROM agents WHERE role='orchestrator' AND archived_at=''").fetchone() or [None])[0]}

class Handler(BaseHTTPRequestHandler):
    server_version='MCPHubMessages/1.0'
    def log_message(self, fmt, *args):
        # Do not log message contents, chat URLs, or private content.
        if os.environ.get('MCPHUB_DEBUG')=='1':
            print('HTTP', self.command, self.path.split('?')[0], file=sys.stderr)

    def result(self, obj, code=200):
        data=json.dumps(obj,ensure_ascii=False).encode('utf8')
        self.send_response(code)
        for k,v in {'Content-Type':'application/json; charset=utf-8','Content-Length':str(len(data)),
                    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
                    'X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'}.items(): self.send_header(k,v)
        self.end_headers()
        self.wfile.write(data)

    def allow(self, writing=False):
        host=self.headers.get('Host','')
        if host not in ('127.0.0.1:8971','localhost:8971'):
            self.result({'error':'Invalid host'},403);return False
        if self.headers.get('X-MCPHub-Client')!='native' or self.headers.get('Origin'):
            self.result({'error':'Native client header required; browser requests disabled'},403);return False
        if writing:
            if not self.headers.get('Content-Type','').startswith('application/json'):
                self.result({'error':'JSON required'},415);return False
        return True

    def do_GET(self):
        if not self.allow():return
        url=urlsplit(self.path)
        q=parse_qs(url.query)
        def param(name,default=''): return q.get(name,[default])[0]
        try:
            with database() as conn:
                if url.path=='/api/status': obj={'ok':True,**stats(conn)}
                elif url.path=='/api/agents': obj={'agents':list_agents(conn,archived=param('archived')=='1')}
                elif url.path=='/api/agents/archived': obj={'agents':list_agents(conn,archived=True)}
                elif url.path=='/api/history':
                    obj={'messages':history(conn,viewer=param('viewer','hub'),agent=param('agent'),limit=int(param('limit','150')))}
                elif url.path=='/api/inbox': obj={'messages':inbox(conn,param('agent'),int(param('limit','80')))}
                else:return self.result({'error':'Not found'},404)
                self.result(obj)
        except (ValueError,sqlite3.Error) as ex:self.result({'error':str(ex)},400)

    def do_POST(self):
        if not self.allow(writing=True):return
        try:
            n=int(self.headers.get('Content-Length','-1'))
            if n<0 or n>26000: return self.result({'error':'Invalid payload size'},413)
            b=json.loads(self.rfile.read(n))
            if not isinstance(b,dict):raise ValueError('Expected JSON object')
            with database() as conn:
                if self.path=='/api/agents':
                    obj=register(conn,b.get('id'),b.get('label'),b.get('role','agent'),b.get('chat_url',''))
                elif self.path=='/api/orchestrator':obj=change_orchestrator(conn,b.get('id'))
                elif self.path=='/api/agents/role':obj=set_role(conn,b.get('id'),b.get('role'))
                elif self.path=='/api/agents/archive':obj=archive_agent(conn,b.get('id'))
                elif self.path=='/api/agents/restore':obj=restore_agent(conn,b.get('id'))
                elif self.path=='/api/agents/replace':obj=replace_agent(conn,b.get('old_id'),b.get('id'),b.get('label'),b.get('chat_url',''))
                elif self.path=='/api/agents/delete':obj=delete_agent(conn,b.get('id'),b.get('confirm'))
                elif self.path=='/api/messages':
                    obj=send(conn,b.get('sender','hub'),b.get('recipient'),b.get('body'),b.get('kind','message'))
                elif self.path=='/api/ack':obj=mark_read(conn,b.get('agent'),b.get('ids',[]))
                else:return self.result({'error':'Not found'},404)
                self.result(obj,201 if self.path=='/api/agents' else 200)
        except (ValueError,KeyError,sqlite3.Error,json.JSONDecodeError) as ex:self.result({'error':str(ex)},400)


def service():
    with ThreadingHTTPServer(('127.0.0.1',PORT),Handler) as s:
        print('MCP Hub messages ready on 127.0.0.1:'+str(PORT),flush=True)
        s.serve_forever()


def cli():
    ap=argparse.ArgumentParser(description='MCP Hub: explicitly shared messages between ChatGPT chats')
    sub=ap.add_subparsers(dest='command',required=True)
    add=sub.add_parser('register',help='Register a chat agent (regular agent only)')
    add.add_argument('--id',required=True)
    add.add_argument('--name',default='')
    add.add_argument('--chat-url',default='')
    sub.add_parser('agents',help='List chat agents and unread counts')
    sub.add_parser('archived',help='List archived chat registrations')
    rolecmd=sub.add_parser('role',help='Set role of active agent')
    rolecmd.add_argument('--id',required=True);rolecmd.add_argument('--role',choices=['agent','orchestrator'],required=True)
    archivecmd=sub.add_parser('archive',help='Retire an agent while preserving shared history')
    archivecmd.add_argument('--id',required=True)
    restorecmd=sub.add_parser('restore',help='Reactivate archived agent')
    restorecmd.add_argument('--id',required=True)
    replacecmd=sub.add_parser('replace',help='Replace an expiring ChatGPT conversation with new agent ID')
    replacecmd.add_argument('--old',required=True);replacecmd.add_argument('--id',required=True)
    replacecmd.add_argument('--name',required=True);replacecmd.add_argument('--chat-url',default='')
    deletecmd=sub.add_parser('delete',help='Permanently delete an archived agent and its messages')
    deletecmd.add_argument('--id',required=True);deletecmd.add_argument('--confirm',required=True)
    owner=sub.add_parser('orchestrator',help='Set the designated orchestrator (local owner action)')
    owner.add_argument('--id',required=True)
    post=sub.add_parser('send',help='Send an opt-in message to a chat or *')
    post.add_argument('--as',dest='sender',required=True)
    post.add_argument('--to',dest='recipient',required=True)
    post.add_argument('--text')
    post.add_argument('--stdin',action='store_true')
    report=sub.add_parser('report',help='Publish your progress to the designated orchestrator')
    report.add_argument('--as',dest='sender',required=True)
    report.add_argument('--text')
    report.add_argument('--stdin',action='store_true')
    incoming=sub.add_parser('inbox',help='Read messages addressed to a chat (does not auto-acknowledge)')
    incoming.add_argument('--as',dest='viewer',required=True)
    incoming.add_argument('--limit',type=int,default=80)
    historycmd=sub.add_parser('history',help='See shared messages, not private ChatGPT transcripts')
    historycmd.add_argument('--as',dest='viewer',default='hub')
    historycmd.add_argument('--agent',default='')
    historycmd.add_argument('--limit',type=int,default=100)
    ack=sub.add_parser('ack',help='Acknowledge received message IDs after processing')
    ack.add_argument('--as',dest='viewer',required=True)
    ack.add_argument('ids',nargs='+',type=int)
    sub.add_parser('status')
    sub.add_parser('serve')
    args=ap.parse_args()
    if args.command=='serve':service();return
    try:
        with database() as conn:
            if args.command=='register':
                obj=register(conn,args.id,args.name or args.id,'agent',args.chat_url)
            elif args.command=='agents':obj={'agents':list_agents(conn)}
            elif args.command=='archived':obj={'agents':list_agents(conn,archived=True)}
            elif args.command=='role':obj=set_role(conn,args.id,args.role)
            elif args.command=='archive':obj=archive_agent(conn,args.id)
            elif args.command=='restore':obj=restore_agent(conn,args.id)
            elif args.command=='replace':obj=replace_agent(conn,args.old,args.id,args.name,args.chat_url)
            elif args.command=='delete':obj=delete_agent(conn,args.id,args.confirm)
            elif args.command=='orchestrator':obj=change_orchestrator(conn,args.id)
            elif args.command in ('send','report'):
                body=sys.stdin.read(MAX_MESSAGE+1) if args.stdin else args.text
                obj=send(conn,args.sender,getattr(args,'recipient','*'),body,
                         'report' if args.command=='report' else 'message')
            elif args.command=='inbox':obj={'messages':inbox(conn,args.viewer,args.limit)}
            elif args.command=='history':obj={'messages':history(conn,args.viewer,args.agent,args.limit)}
            elif args.command=='ack':obj=mark_read(conn,args.viewer,args.ids)
            else:obj=stats(conn)
        print(json.dumps(obj,ensure_ascii=False,indent=2))
    except (ValueError,sqlite3.Error) as e:
        print(json.dumps({'error':str(e)},ensure_ascii=False),file=sys.stderr)
        sys.exit(2)

if __name__=='__main__':cli()
