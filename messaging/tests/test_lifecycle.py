import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC=importlib.util.spec_from_file_location('hub',str(Path(__file__).resolve().parents[1]/'hub.py'))
hub=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(hub)

class AgentLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        hub.DATA=Path(self.tmp.name)/'messages.sqlite3'
        self.ctx=hub.database(); self.db=self.ctx.__enter__()
        hub.register(self.db,'ORCH','Первый','orchestrator')
        hub.register(self.db,'API','Backend')
        hub.register(self.db,'QA','QA')
    def tearDown(self):
        self.ctx.__exit__(None,None,None)
        self.tmp.cleanup()

    def test_demote_orchestrator_with_no_replacement(self):
        hub.set_role(self.db,'ORCH','agent')
        self.assertIsNone(hub.stats(self.db)['orchestrator'])
        self.assertEqual(hub.exists(self.db,'ORCH')['role'],'agent')
        with self.assertRaisesRegex(ValueError,'Orchestrator not configured'):
            hub.send(self.db,'API','ORCH','status','report')
        hub.set_role(self.db,'QA','orchestrator')
        self.assertEqual(hub.stats(self.db)['orchestrator'],'QA')
        hub.set_role(self.db,'API','orchestrator')
        self.assertEqual(hub.exists(self.db,'QA')['role'],'agent')

    def test_archiving_orchestrator_keeps_history_and_no_master(self):
        m=hub.send(self.db,'API','ORCH','Отчёт')
        hub.archive_agent(self.db,'ORCH')
        self.assertIsNone(hub.stats(self.db)['orchestrator'])
        self.assertEqual(len(hub.list_agents(self.db)),2)
        self.assertEqual(hub.list_agents(self.db,archived=True)[0]['id'],'ORCH')
        self.assertEqual(len(hub.history(self.db,'hub')),1)
        with self.assertRaisesRegex(ValueError,'archived'):
            hub.inbox(self.db,'ORCH')
        with self.assertRaisesRegex(ValueError,'archived'):
            hub.send(self.db,'API','ORCH','new')
        with self.assertRaisesRegex(ValueError,'archived'):
            hub.send(self.db,'ORCH','QA','bad')
        hub.restore_agent(self.db,'ORCH')
        self.assertEqual(hub.inbox(self.db,'ORCH')[0]['id'],m['id'])
        self.assertIsNone(hub.stats(self.db)['orchestrator']) # restore does not silently grant permissions
        hub.set_role(self.db,'ORCH','orchestrator')

    def test_replacement_preserves_ledger_and_redirects_unread(self):
        first=hub.send(self.db,'ORCH','API','Пожалуйста проверь API')
        hub.mark_read(self.db,'API',[first['id']])
        second=hub.send(self.db,'QA','API','Нужно проверить тесты')
        hub.send(self.db,'API','ORCH','Отчёт: готовы сборки','report')
        r=hub.replace_agent(self.db,'API','API2','Backend новая сессия','https://chatgpt.com/c/123')
        self.assertEqual(r['forwarded'],1)
        self.assertEqual(r['agent']['role'],'agent')
        self.assertEqual(hub.exists(self.db,'API')['replaced_by'],'API2')
        inbox=hub.inbox(self.db,'API2')
        self.assertEqual(len(inbox),2) # pending direct + last report
        self.assertIn('Нужно проверить тесты',inbox[0]['body'])
        self.assertIn('Отчёт: готовы сборки',inbox[1]['body'])
        self.assertEqual(len([x for x in hub.history(self.db,'hub') if x['recipient']=='API']),2)
        with self.assertRaisesRegex(ValueError,'archived'):
            hub.inbox(self.db,'API')
        self.assertEqual(hub.exists(self.db,'QA')['role'],'agent')
        with self.assertRaisesRegex(ValueError,'reserved'):
            hub.register(self.db,'API','reuse')

    def test_replacement_handover_orchestrator(self):
        hub.send(self.db,'QA','ORCH','status')
        hub.replace_agent(self.db,'ORCH','ORCH2','Orchestrator 2')
        self.assertEqual(hub.stats(self.db)['orchestrator'],'ORCH2')
        self.assertEqual(hub.exists(self.db,'ORCH')['role'],'agent')
        self.assertEqual(len(hub.inbox(self.db,'ORCH2')),1)
        self.assertEqual(len(hub.list_agents(self.db,archived=True)),1)

    def test_permanent_delete_requires_archival_and_confirmation(self):
        first=hub.send(self.db,'ORCH','API','private')
        other=hub.send(self.db,'ORCH','QA','keep')
        hub.archive_agent(self.db,'API')
        with self.assertRaisesRegex(ValueError,'Confirmation'):
            hub.delete_agent(self.db,'API','wrong')
        with self.assertRaisesRegex(ValueError,'Archive'):
            hub.delete_agent(self.db,'QA','QA')
        r=hub.delete_agent(self.db,'API','API')
        self.assertEqual(r['deleted_messages'],1)
        self.assertNotIn('API',[a['id'] for a in hub.list_agents(self.db,archived=True)])
        self.assertEqual([m['id'] for m in hub.history(self.db,'hub')],[other['id']])
        with self.assertRaisesRegex(ValueError,'Unknown'):
            hub.exists(self.db,'API')
        self.assertEqual(hub.stats(self.db)['orchestrator'],'ORCH')

    def test_replacement_failed_validation_keeps_original(self):
        with self.assertRaises(ValueError):hub.replace_agent(self.db,'ORCH','bad id','invalid')
        self.assertEqual(hub.stats(self.db)['orchestrator'],'ORCH')
        self.assertEqual(len(hub.list_agents(self.db,archived=True)),0)

if __name__=='__main__':unittest.main()
