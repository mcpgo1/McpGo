import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

SPEC=importlib.util.spec_from_file_location('hub',str(Path(__file__).resolve().parents[1]/'hub.py'))
hub=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(hub)

class APITest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        hub.DATA=Path(self.temp.name)/'messages.sqlite3'
        self.server=ThreadingHTTPServer(('127.0.0.1',0),hub.Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown();self.server.server_close()
        self.thread.join(timeout=3)
        self.temp.cleanup()

    def request(self,path,payload=None,headers=None):
        d=None if payload is None else json.dumps(payload).encode()
        request=urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}'+path,data=d,
                                        headers={'Host':'127.0.0.1:8971','X-MCPHub-Client':'native',
                                                 **({'Content-Type':'application/json'} if d else {}),**(headers or {})})
        with urllib.request.urlopen(request,timeout=3) as res:
            return res.status,json.load(res)

    def test_full_message_flow(self):
        a,obj=self.request('/api/agents',{'id':'ORCH','label':'Оркестратор','role':'orchestrator'})
        self.assertEqual(a,201)
        self.request('/api/agents',{'id':'QA','label':'QA'})
        status,msg=self.request('/api/messages',{'sender':'ORCH','recipient':'QA','body':'Проверь тесты'})
        self.assertEqual(status,200)
        _,inbox=self.request('/api/inbox?agent=QA')
        self.assertEqual(len(inbox['messages']),1)
        self.assertEqual(inbox['messages'][0]['body'],'Проверь тесты')
        self.request('/api/ack',{'agent':'QA','ids':[msg['id']]})
        _,inbox=self.request('/api/inbox?agent=QA')
        self.assertEqual(inbox['messages'],[])
        self.request('/api/messages',{'sender':'QA','recipient':'ORCH','body':'Готово','kind':'report'})
        _,data=self.request('/api/history?viewer=ORCH')
        self.assertEqual(len(data['messages']),2)
        _,agents=self.request('/api/agents')
        self.assertEqual(next(x for x in agents['agents'] if x['id']=='QA')['last_report'],'Готово')

    def test_reject_cross_site_and_invalid_sender(self):
        req=urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}/api/status',headers={'Host':'127.0.0.1:8971'})
        with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(req,timeout=3)
        self.assertEqual(e.exception.code,403)
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.request('/api/messages',{'sender':'nobody','recipient':'*','body':'text'})
        self.assertEqual(e.exception.code,400)

if __name__=='__main__':unittest.main()

class LifecycleHTTPTest(APITest):
    def test_role_archive_restore_replace_permanent_delete(self):
        self.request('/api/agents',{'id':'ORCH','label':'Руководитель','role':'orchestrator'})
        self.request('/api/agents',{'id':'QA','label':'QA-Old'})
        self.request('/api/messages',{'sender':'ORCH','recipient':'QA','body':'Незавершённая задача'})
        _,changed=self.request('/api/agents/role',{'id':'ORCH','role':'agent'})
        self.assertEqual(changed['role'],'agent')
        self.request('/api/agents/role',{'id':'QA','role':'orchestrator'})
        _,result=self.request('/api/agents/replace',{'old_id':'QA','id':'QA2','label':'QA-New','chat_url':'https://chatgpt.com/c/test'})
        self.assertEqual(result['agent']['role'],'orchestrator')
        self.assertEqual(result['forwarded'],1)
        _,inbox=self.request('/api/inbox?agent=QA2')
        self.assertEqual(len(inbox['messages']),1)
        self.assertIn('Незавершённая задача',inbox['messages'][0]['body'])
        _,archived=self.request('/api/agents/archived')
        self.assertEqual(len(archived['agents']),1)
        self.assertEqual(archived['agents'][0]['replaced_by'],'QA2')
        _,active=self.request('/api/agents')
        self.assertEqual({a['id'] for a in active['agents']},{'ORCH','QA2'})
        with self.assertRaises(urllib.error.HTTPError) as ex:
            self.request('/api/agents/delete',{'id':'QA','confirm':'wrong'})
        self.assertEqual(ex.exception.code,400)
        _,removed=self.request('/api/agents/delete',{'id':'QA','confirm':'QA'})
        self.assertEqual(removed['deleted'],'QA')
        self.assertEqual(removed['deleted_messages'],1)
        _,stillActive=self.request('/api/agents')
        self.assertEqual({a['id'] for a in stillActive['agents']},{'ORCH','QA2'})
        self.request('/api/agents/archive',{'id':'QA2'})
        _,restored=self.request('/api/agents/restore',{'id':'QA2'})
        self.assertEqual(restored['archived_at'],'')
        self.assertEqual(restored['role'],'agent')
