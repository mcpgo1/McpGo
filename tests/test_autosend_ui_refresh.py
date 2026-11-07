"""Static regression gates for the native AutoSend status polling lifecycle."""
import unittest
from pathlib import Path

SOURCE=(Path(__file__).resolve().parents[1]/'native/ScheduledMessages.swift').read_text()

class AutoSendUIRefreshTests(unittest.TestCase):
    def test_polling_belongs_to_swiftui_task_lifecycle(self):
        self.assertIn('.task {',SOURCE)
        self.assertIn('while !Task.isCancelled',SOURCE)
        self.assertIn('active ? 2 : 5',SOURCE)
        self.assertNotIn('private let poll=',SOURCE)
        self.assertNotIn('.onReceive(poll)',SOURCE)

    def test_no_overlapping_status_requests(self):
        self.assertIn('guard !refreshInFlight, !loading else { return }',SOURCE)
        self.assertIn('defer { refreshInFlight=false }',SOURCE)

    def test_actions_refresh_immediately_after_success(self):
        self.assertIn('loading=false\n            await refresh()',SOURCE)

if __name__=='__main__': unittest.main()
