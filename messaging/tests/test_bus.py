import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

SPEC=importlib.util.spec_from_file_location('hub',str(Path(__file__).resolve().parents[1]/'hub.py'))
hub=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hub)

class BusTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        hub.DATA=Path(self.temp.name)/'bus.db'
        self.ctx=hub.database()
        self.db=self.ctx.__enter__()
        hub.register(self.db,'ORCH','Оркестратор','orchestrator')
        hub.register(self.db,'AG1','Backend')
        hub.register(self.db,'AG2','QA')

    def tearDown(self):
        self.ctx.__exit__(None,None,None)
        self.temp.cleanup()

    def test_direct_address_and_ack(self):
        m=hub.send(self.db,'ORCH','AG1','Проверь API')
        self.assertEqual([x['id'] for x in hub.inbox(self.db,'AG1')],[m['id']])
        self.assertEqual(hub.inbox(self.db,'AG2'),[])
        hub.mark_read(self.db,'AG1',[m['id']])
        self.assertEqual(hub.inbox(self.db,'AG1'),[])
        self.assertEqual(len(hub.history(self.db,'ORCH')),1)

    def test_private_history_is_not_available_to_other_agents(self):
        hub.send(self.db,'ORCH','AG1','first')
        hub.send(self.db,'ORCH','AG2','second')
        self.assertEqual(len(hub.history(self.db,'AG1')),1)
        with self.assertRaises(ValueError):hub.history(self.db,'AG1',agent='AG2')
        self.assertEqual(len(hub.history(self.db,'ORCH')),2)

    def test_report_orchestrator_and_broadcast(self):
        hub.send(self.db,'AG1','*','Всем привет')
        self.assertEqual(len(hub.inbox(self.db,'ORCH')),1)
        self.assertEqual(len(hub.inbox(self.db,'AG2')),1)
        self.assertEqual(len(hub.inbox(self.db,'AG1')),0)
        hub.send(self.db,'AG2','*','Готово','report')
        self.assertEqual(hub.list_agents(self.db)[2]['last_report'],'Готово')
        self.assertEqual(hub.history(self.db,'AG1')[-1]['body'],'Всем привет')

    def test_orchestrator_switch_and_validation(self):
        with self.assertRaises(ValueError):hub.register(self.db,'O2','other','orchestrator')
        hub.change_orchestrator(self.db,'AG2')
        self.assertEqual(hub.stats(self.db)['orchestrator'],'AG2')
        with self.assertRaises(ValueError):hub.send(self.db,'AG1','hub','not allowed')
        with self.assertRaises(ValueError):hub.send(self.db,'AG1','AG2','')
        with self.assertRaises(ValueError):hub.mark_read(self.db,'AG1',[100])

    def test_db_file_is_private(self):
        self.assertEqual(hub.DATA.stat().st_mode & 0o777,0o600)

if __name__=='__main__':unittest.main()
