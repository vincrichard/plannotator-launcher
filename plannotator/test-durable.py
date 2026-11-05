import sys,json,os,signal,socket,subprocess,tempfile,time,unittest,urllib.request
from pathlib import Path
from unittest.mock import patch
import durable
ROOT=Path(__file__).resolve().parent

class DurableReviewTest(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='plannotator-durable-test-');self.root=Path(self.temp.name);self.children=[]
  with socket.socket() as s:s.bind(('127.0.0.1',0));self.port=s.getsockname()[1]
  (self.root/'bin').mkdir();fake=self.root/'bin/plannotator'
  fake.write_text('''#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
if '--version' in sys.argv: print('plannotator 0.28.20-references.29');sys.exit()
class H(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_GET(self):
  self.send_response(200);self.end_headers()
  self.wfile.write(json.dumps({'reviewLifecycle':{'id':os.environ.get('PLANNOTATOR_REVIEW_ID'),'frozen':Path(os.environ.get('PLANNOTATOR_REVIEW_CHECKPOINT','/missing')).exists()}}).encode())
 def do_POST(self):
  if self.path == '/api/host/suspend':
   assert self.headers.get('Authorization') == 'Bearer '+os.environ['PLANNOTATOR_REVIEW_CONTROL_TOKEN']
   failed=os.environ.get('FAKE_SUSPEND_FAILURE')
   if not failed: Path(os.environ['PLANNOTATOR_REVIEW_CHECKPOINT']).write_text('{"saved":true}')
   self.send_response(409 if failed else 200);self.end_headers();self.wfile.write(json.dumps({'error':failed} if failed else {'saved':True}).encode());return
  if self.path == '/api/agents/jobs':
   body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
   Path(os.environ['PLANNOTATOR_DATA_DIR']).joinpath('guide-request.json').write_text(json.dumps(body))
   failed=os.environ.get('FAKE_GUIDE_FAILURE')
   self.send_response(503 if failed else 201);self.end_headers()
   self.wfile.write(json.dumps({'error':'Guide unavailable'} if failed else {'job':{'id':'test-guide','status':'running'}}).encode());return
  self.send_response(200);self.end_headers();self.wfile.write(b'{}');self.wfile.flush()
  print('invalid output' if os.environ.get('FAKE_INVALID_OUTPUT') else json.dumps({'decision':'annotated','message':'durable feedback'}),flush=True)
  os._exit(0)
s=HTTPServer(('127.0.0.1',0),H)
Path(os.environ['PLANNOTATOR_READY_FILE']).write_text(json.dumps({'url':f'http://127.0.0.1:{s.server_port}'}))
s.serve_forever()
''');fake.chmod(0o755)
  self.env={**os.environ,'PYTHONPATH':str(ROOT),'PATH':str(self.root/'bin')+':'+os.environ['PATH'],'PLANNOTATOR_REVIEW_STATE_DIR':str(self.root/'records'),'PLANNOTATOR_REVIEW_NOTIFY':'0','PLANNOTATOR_DATA_DIR':str(self.root/'config')}
  self.env.pop('HERDR_ENV',None)
  self.code="import runpy,sys;from pathlib import Path;m=runpy.run_path(sys.argv[1]);g=m['main'].__globals__;g['STATE']=Path(sys.argv[2]);g['PORT']=int(sys.argv[3]);sys.argv=[sys.argv[1],*sys.argv[4:]];sys.exit(m['main']())"
  # Exercise the launcher without initializing the shared sites data directory.
  (self.root/'routes').mkdir(mode=0o700)
  proxy=subprocess.Popen(['node',str(ROOT/'proxy.mjs'),str(self.root/'routes'),str(self.port)],env=self.env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  self.children.append(proxy)
  def healthy():
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/health',timeout=1) as response:return response.status==200
   except OSError:return False
  self.until(healthy)
 def cli(self,*args):return [sys.executable,'-c',self.code,str(ROOT/'mobile.py'),str(self.root/'routes'),str(self.port),*args]
 def runcli(self,*args):return subprocess.run(self.cli(*args),env=self.env,capture_output=True,text=True,timeout=15)
 def until(self,fn):
  for _ in range(200):
   if value:=fn():return value
   time.sleep(.05)
  self.fail('Timed out')
 def tearDown(self):
  for p in (self.root/'records').glob('*'):
   if (p/'session.json').exists():self.runcli('--cancel',p.name)
  for child in self.children:
   if child.poll() is None:child.terminate()
   child.wait(timeout=5)
  for p in (self.root/'records').glob('*'):
   self.until(lambda:json.loads((p/'session.json').read_text())['status'] in ('completed','cancelled','failed','suspended'))
  pidfile=self.root/'routes/proxy.pid'
  if pidfile.exists():os.kill(int(pidfile.read_text()),signal.SIGTERM)
  self.temp.cleanup()
 def test_caller_and_waiter_cancellation_preserve_review_feedback_and_route(self):
  log=(self.root/'caller.log').open('w')
  child=subprocess.Popen(self.cli(),env=self.env,stdout=log,stderr=log,start_new_session=True);self.children.append(child)
  route=self.until(lambda:next((self.root/'routes').glob('*/route.json'),None));sid=route.parent.name
  os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=5);log.close()
  record=json.loads(self.runcli('--status',sid).stdout)
  self.assertEqual(record['status'],'running');self.assertTrue(route.exists())
  self.assertEqual(urllib.request.urlopen(record['direct_url']).status,200)
  waiter=subprocess.Popen(self.cli('--wait',sid),env=self.env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True);self.children.append(waiter)
  os.killpg(waiter.pid,signal.SIGTERM);waiter.wait(timeout=5)
  self.assertEqual(self.runcli('--result',sid).returncode,2)
  urllib.request.urlopen(urllib.request.Request(record['direct_url']+'/feedback',data=b'{}'))
  self.until(lambda:(self.root/'records'/sid/'notification.json').exists())
  result=self.runcli('--result',sid);self.assertEqual(result.returncode,0);self.assertEqual(json.loads(result.stdout)['message'],'durable feedback')
  self.assertEqual(json.loads(self.runcli('--wait',sid).stdout),json.loads(result.stdout))
  self.assertFalse(route.exists());self.assertEqual(len(json.loads(self.runcli('--notifications').stdout)),1)
  self.assertEqual(self.runcli('--ack',sid).returncode,0);self.assertEqual(json.loads(self.runcli('--notifications').stdout),[])
  self.assertEqual((self.root/'records'/sid/'feedback.json').stat().st_mode & 0o077,0)
 def test_viewed_progress_is_shared_but_drafts_stay_session_local(self):
  first=json.loads(self.runcli('--detach').stdout)
  a=self.root/'records'/first['id']/'data'
  (a/'review-progress'/'scope').mkdir(parents=True,exist_ok=True)
  (a/'review-progress'/'scope'/'file.json').write_text('{"viewed":true}')
  (a/'drafts').mkdir();(a/'drafts'/'note.json').write_text('private draft')
  second=json.loads(self.runcli('--detach').stdout)
  b=self.root/'records'/second['id']/'data'
  self.assertEqual((b/'review-progress'/'scope'/'file.json').read_text(),'{"viewed":true}')
  self.assertFalse((b/'drafts'/'note.json').exists())
  self.assertEqual((b/'review-progress').resolve(),self.root/'config'/'review-progress')
  self.env['PLANNOTATOR_DATA_DIR']=str(self.root/'another-data-dir')
  third=json.loads(self.runcli('--detach').stdout)
  c=self.root/'records'/third['id']/'data'
  self.assertFalse((c/'review-progress'/'scope'/'file.json').exists())
 def test_suspend_resume_keeps_identity_data_and_does_not_submit_feedback(self):
  record=json.loads(self.runcli('--detach').stdout);sid=record['id'];path=self.root/'records'/sid
  (path/'data'/'unfinished.json').write_text('{"text":"keep my comment"}')
  route=self.root/'routes'/sid/'route.json';token=json.loads(route.read_text())['token']
  self.assertEqual(self.runcli('--suspend',sid).returncode,0)
  self.until(lambda:json.loads(self.runcli('--status',sid).stdout)['status']=='suspended')
  self.until(lambda:durable.identity(record['review_pid']) is None)
  self.assertFalse((path/'feedback.json').exists());self.assertFalse((path/'notification.json').exists())
  self.assertEqual(self.runcli('--result',sid).returncode,2)
  self.assertEqual(json.loads(route.read_text())['status'],'suspended')
  base=f'http://127.0.0.1:{self.port}'
  listing=json.load(urllib.request.urlopen(base+'/reviews/launcher/reviews'))['reviews']
  self.assertEqual(listing[0]['status'],'suspended');self.assertNotIn(token,json.dumps(listing))
  with self.assertRaises(urllib.error.HTTPError) as refused:
   urllib.request.urlopen(urllib.request.Request(base+'/reviews/launcher/resume/'+sid,data=b''))
  self.assertEqual(refused.exception.code,403)
  result=json.load(urllib.request.urlopen(urllib.request.Request(base+'/reviews/launcher/resume/'+sid,data=b'',headers={'X-Review-Action':'1'})))
  self.assertEqual(result['status'],'running')
  resumed=json.loads(self.runcli('--status',sid).stdout)
  self.assertEqual(resumed['status'],'running');self.assertEqual(resumed['id'],sid)
  self.assertNotEqual(resumed['review_pid'],record['review_pid'])
  self.assertEqual(json.loads(route.read_text())['token'],token)
  self.assertEqual(resumed['proxy_url'],record['proxy_url'])
  self.assertEqual((path/'data'/'unfinished.json').read_text(),'{"text":"keep my comment"}')
  again=json.loads(self.runcli('--resume',sid).stdout)
  self.assertEqual(again['review_pid'],resumed['review_pid'])
  urllib.request.urlopen(urllib.request.Request(resumed['direct_url'],data=b'{}'))
  self.until(lambda:json.loads(self.runcli('--status',sid).stdout)['status']=='completed')
  self.assertEqual(self.runcli('--result',sid).returncode,0);self.assertFalse(route.exists())
 def test_home_close_uses_supervisor_and_keeps_saved_comments(self):
  record=json.loads(self.runcli('--detach').stdout);sid=record['id'];path=self.root/'records'/sid
  note=path/'data'/'unfinished.json';note.write_text('{"text":"keep this comment"}')
  url=f'http://127.0.0.1:{self.port}/reviews/launcher/close/{sid}'
  for method,headers,expected in [('GET',{},405),('POST',{},403),('POST',{'X-Review-Action':'1','Origin':'http://foreign.test'},403)]:
   with self.assertRaises(urllib.error.HTTPError) as refused:
    urllib.request.urlopen(urllib.request.Request(url,method=method,headers=headers))
   self.assertEqual(refused.exception.code,expected)
  self.assertFalse((path/'cancel').exists())
  result=json.load(urllib.request.urlopen(urllib.request.Request(url,data=b'',headers={'X-Review-Action':'1'})))
  self.assertTrue(result['cancel_requested'])
  self.until(lambda:json.loads(self.runcli('--status',sid).stdout)['status']=='cancelled')
  self.until(lambda:durable.identity(record['review_pid']) is None)
  self.assertFalse((path/'feedback.json').exists());self.assertEqual(note.read_text(),'{"text":"keep this comment"}')
  self.assertEqual(json.load(urllib.request.urlopen(f'http://127.0.0.1:{self.port}/reviews/launcher/reviews'))['reviews'],[])
  with self.assertRaises(urllib.error.HTTPError) as ended:
   urllib.request.urlopen(urllib.request.Request(url,data=b'',headers={'X-Review-Action':'1'}))
  self.assertEqual(ended.exception.code,410)
 def test_home_save_close_retains_files_when_checkpoint_is_unsupported(self):
  for reason in ['Reviews with agent jobs cannot be suspended yet', 'Wait for the discussion answer before suspending', 'Refresh the changed diff before suspending']:
   with self.subTest(reason=reason):
    self.env['FAKE_SUSPEND_FAILURE']=reason
    record=json.loads(self.runcli('--detach').stdout);sid=record['id'];path=self.root/'records'/sid
    note=path/'data'/'unfinished.json';note.write_text('saved comment')
    url=f'http://127.0.0.1:{self.port}/reviews/launcher/save-close/{sid}'
    result=json.load(urllib.request.urlopen(urllib.request.Request(url,data=b'',headers={'X-Review-Action':'1'})))
    self.assertTrue(result['cancel_requested']);self.assertIn('saved files',result['reason'])
    self.until(lambda:json.loads(self.runcli('--status',sid).stdout)['status']=='cancelled')
    self.until(lambda:durable.identity(record['review_pid']) is None)
    self.assertEqual(note.read_text(),'saved comment');self.assertFalse((path/'feedback.json').exists())
    self.assertFalse((self.root/'routes'/sid/'route.json').exists())
 def test_home_save_close_preserves_retryable_failures(self):
  for reason in ['Recent reviewer changes are still saving; wait a moment and retry', 'No space left on device']:
   with self.subTest(reason=reason):
    self.env['FAKE_SUSPEND_FAILURE']=reason
    record=json.loads(self.runcli('--detach').stdout);sid=record['id'];path=self.root/'records'/sid
    # A stale unsupported error must not override the result of this attempt.
    saved=json.loads((path/'session.json').read_text());saved['suspend_error']='Could not safely suspend; review remains running: Reviews with agent jobs cannot be suspended yet'
    durable.atomic(path/'session.json',saved)
    url=f'http://127.0.0.1:{self.port}/reviews/launcher/save-close/{sid}'
    with self.assertRaises(urllib.error.HTTPError) as refused:
     urllib.request.urlopen(urllib.request.Request(url,data=b'',headers={'X-Review-Action':'1'}))
    self.assertEqual(refused.exception.code,409)
    self.assertFalse((path/'cancel').exists());self.assertEqual(json.loads(self.runcli('--status',sid).stdout)['status'],'running')
 def test_home_save_close_supports_legacy_managed_reviews(self):
  record=json.loads(self.runcli('--detach').stdout);sid=record['id'];path=self.root/'records'/sid
  launch=json.loads((path/'launch.json').read_text());launch.pop('lifecycle');durable.atomic(path/'launch.json',launch)
  note=path/'data'/'unfinished.json';note.write_text('saved legacy comment')
  url=f'http://127.0.0.1:{self.port}/reviews/launcher/save-close/{sid}'
  result=json.load(urllib.request.urlopen(urllib.request.Request(url,data=b'',headers={'X-Review-Action':'1'})))
  self.assertTrue(result['cancel_requested'])
  self.until(lambda:json.loads(self.runcli('--status',sid).stdout)['status']=='cancelled')
  self.assertEqual(note.read_text(),'saved legacy comment');self.assertFalse((path/'checkpoint.json').exists())
 def test_home_save_close_prefers_resumable_checkpoint(self):
  record=json.loads(self.runcli('--detach').stdout);sid=record['id'];path=self.root/'records'/sid
  url=f'http://127.0.0.1:{self.port}/reviews/launcher/save-close/{sid}'
  for method,headers,expected in [('GET',{},405),('POST',{},403),('POST',{'X-Review-Action':'1','Origin':'http://foreign.test'},403)]:
   with self.assertRaises(urllib.error.HTTPError) as refused:
    urllib.request.urlopen(urllib.request.Request(url,method=method,headers=headers))
   self.assertEqual(refused.exception.code,expected)
  result=json.load(urllib.request.urlopen(urllib.request.Request(url,data=b'',headers={'X-Review-Action':'1'})))
  self.assertEqual(result['status'],'suspended');self.assertFalse((path/'cancel').exists())
  self.assertTrue((path/'checkpoint.json').exists());self.assertFalse((path/'feedback.json').exists())
 def test_failed_checkpoint_leaves_review_running_and_retryable(self):
  self.env['FAKE_SUSPEND_FAILURE']='1'
  record=json.loads(self.runcli('--detach').stdout);sid=record['id'];path=self.root/'records'/sid
  self.runcli('--suspend',sid)
  current=self.until(lambda:(r if (r:=json.loads(self.runcli('--status',sid).stdout)).get('suspend_error') else None))
  self.assertEqual(current['status'],'running')
  self.assertEqual(urllib.request.urlopen(current['direct_url']).status,200)
  self.assertFalse((path/'checkpoint.json').exists());self.assertFalse((path/'feedback.json').exists())
 def test_resume_failure_keeps_checkpoint_offline(self):
  record=json.loads(self.runcli('--detach').stdout);sid=record['id'];path=self.root/'records'/sid
  self.runcli('--suspend',sid)
  self.until(lambda:json.loads(self.runcli('--status',sid).stdout)['status']=='suspended')
  fake=self.root/'bin/plannotator';fake.write_text('#!/usr/bin/env python3\nimport sys\nsys.exit(1)\n')
  failed=self.runcli('--resume',sid);self.assertEqual(failed.returncode,1)
  self.assertEqual(json.loads(failed.stdout)['status'],'suspended')
  self.assertTrue((path/'checkpoint.json').exists())
  self.assertEqual(json.loads((self.root/'routes'/sid/'route.json').read_text())['status'],'suspended')
 def test_suspend_automatically_prepares_unsent_prompt_only_in_same_idle_agent(self):
  state,delivery=self.fake_agent()
  current=json.loads(state.read_text());current['agent']['interactive_ready']=True;state.write_text(json.dumps(current))
  paste=self.root/'paste.json';host=self.root/'bin/herdr'
  host.write_text(host.read_text().replace("else: raise RuntimeError('Unexpected Herdr command')", "elif sys.argv[1:3]==['pane','send-text']: Path("+repr(str(paste))+").write_text(json.dumps(sys.argv[1:]))\nelse: raise RuntimeError('Unexpected Herdr command')"))
  record=json.loads(self.runcli('--detach').stdout);sid=record['id']
  self.runcli('--suspend',sid)
  self.until(lambda:json.loads(self.runcli('--status',sid).stdout)['status']=='suspended')
  self.until(paste.exists);self.assertFalse(delivery.exists())
  args=json.loads(paste.read_text())
  self.assertEqual(args[:3],['pane','send-text','w1:p1']);self.assertNotIn('\n',args[3]);self.assertNotIn('\r',args[3]);self.assertIn('--resume '+sid,args[3])
  paste.unlink()
  for status,ready in [('working',True),('idle',False)]:
   with self.subTest(agent_status=status,interactive_ready=ready):
    current['agent'].update(agent_status=status,interactive_ready=ready);state.write_text(json.dumps(current))
    result=self.runcli('--prepare-resume',sid);self.assertEqual(result.returncode,0,result.stderr)
    self.assertFalse(json.loads(result.stdout)['prepared']);self.assertFalse(paste.exists());self.assertFalse(delivery.exists())
  current['agent'].update(agent_status='idle',interactive_ready=True)
  current['agent']['agent_session']['value']='different';state.write_text(json.dumps(current))
  self.assertFalse(json.loads(self.runcli('--prepare-resume',sid).stdout)['prepared']);self.assertFalse(paste.exists())
 def test_unavailable_shared_progress_does_not_block_review(self):
  source=self.root/'config';source.mkdir();(source/'review-progress').write_text('not a directory')
  result=self.runcli('--detach');self.assertEqual(result.returncode,0,result.stderr)
  record=json.loads(result.stdout);self.assertEqual(record['status'],'running')
  data=self.root/'records'/record['id']/'data'
  self.assertFalse((data/'review-progress').is_symlink())
  (data/'review-progress').mkdir()
  self.assertIn('Could not share viewed-file progress',(data.parent/'supervisor.log').read_text())
 def test_guide_is_opt_in_and_receipt_retains_the_job(self):
  ordinary=json.loads(self.runcli('--detach').stdout)
  self.assertNotIn('guide_job_id',ordinary)
  self.assertFalse((self.root/'records'/ordinary['id']/'data/guide-request.json').exists())
  launched=self.runcli('--detach','--generate-guide');self.assertEqual(launched.returncode,0,launched.stderr)
  record=json.loads(launched.stdout);self.assertEqual(record['guide_job_id'],'test-guide')
  self.assertEqual(json.loads((self.root/'records'/record['id']/'data/guide-request.json').read_text()),{'provider':'guide','label':'Requested review guide'})
  self.assertEqual(json.loads(self.runcli('--status',record['id']).stdout)['guide_job_id'],'test-guide')
  args=json.loads((self.root/'records'/record['id']/'launch.json').read_text())['args']
  self.assertNotIn('--generate-guide',args)
 def test_guide_failure_keeps_review_and_reports_error(self):
  self.env['FAKE_GUIDE_FAILURE']='1'
  launched=self.runcli('--detach','--generate-guide');self.assertEqual(launched.returncode,1)
  record=json.loads(launched.stdout);self.assertEqual(record['status'],'running')
  self.assertIn('Guide unavailable',record['guide_error']);self.assertIn('do not relaunch',launched.stderr)
  self.assertEqual(urllib.request.urlopen(record['direct_url']).status,200)
 def test_completion_never_shows_a_herdr_toast(self):
  target=self.root/'host-notification.json'
  host=self.root/'bin/herdr';host.write_text('#!/usr/bin/env python3\nimport json,sys\nfrom pathlib import Path\nPath('+repr(str(target))+').write_text(json.dumps(sys.argv[1:]))\n');host.chmod(0o755)
  self.env.pop('PLANNOTATOR_REVIEW_NOTIFY')
  self.env.pop('HERDR_ENV',None)
  record=json.loads(self.runcli('--detach').stdout)
  urllib.request.urlopen(urllib.request.Request(record['direct_url'],data=b'{}'))
  event=self.root/'records'/record['id']/'notification.json'
  self.until(lambda:event.exists() and json.loads(event.read_text()).get('delivery'))
  self.assertFalse(target.exists())
  self.assertEqual(json.loads(event.read_text())['delivery'],'durable-only')
 def fake_agent(self, provider='codex'):
  state=self.root/'agent-state.json'; delivery=self.root/'agent-delivery.json'
  session='ses_fixture' if provider=='opencode' else '11111111-1111-4111-8111-111111111111'
  state.write_text(json.dumps({'agent':{'agent':provider,'pane_id':'w1:p1','terminal_id':'fixture-terminal','agent_status':'idle','agent_session':{'kind':'id','value':session}},'process_info':{'foreground_process_group_id':os.getpid(),'foreground_processes':[{'name':provider,'argv':[provider]}]}}))
  host=self.root/'bin/herdr'
  host.write_text('''#!/usr/bin/env python3
import json,sys
from pathlib import Path
state=json.loads(Path('''+repr(str(state))+''').read_text())
if sys.argv[1:3]==['agent','get']: print(json.dumps({'result':{'agent':state['agent']}}))
elif sys.argv[1:3]==['pane','process-info']: print(json.dumps({'result':{'process_info':state['process_info']}}))
elif sys.argv[1:3]==['agent','prompt']:
 review_id=sys.argv[4].split('--result ',1)[1].split()[0]
 assert Path('''+repr(str(self.root/'records'))+''',review_id,'feedback.json').is_file()
 Path('''+repr(str(delivery))+''').write_text(json.dumps(sys.argv[1:]))
 sys.exit(state.get('exit_code',0))
else: raise RuntimeError('Unexpected Herdr command')
''');host.chmod(0o755)
  self.env.update(HERDR_ENV='1',HERDR_PANE_ID='w1:p1',PLANNOTATOR_REVIEW_NOTIFY='1',PLANNOTATOR_DISCUSSION_PROVIDER=provider,PLANNOTATOR_DISCUSSION_SESSION_ID=session)
  return state,delivery
 def test_completed_feedback_prompts_only_the_verified_launching_agent(self):
  for provider in ['codex','claude','opencode']:
   with self.subTest(provider=provider):
    state,delivery=self.fake_agent(provider);delivery.unlink(missing_ok=True)
    for key in ['PLANNOTATOR_DISCUSSION_PROVIDER','PLANNOTATOR_DISCUSSION_SESSION_ID','CODEX_THREAD_ID','OPENCODE_SESSION_ID','CLAUDE_CODE_SESSION_ID','PLANNOTATOR_SESSION_TAG']:self.env.pop(key,None)
    key={'codex':'CODEX_THREAD_ID','claude':'CLAUDE_CODE_SESSION_ID','opencode':'OPENCODE_SESSION_ID'}[provider]
    self.env[key]=json.loads(state.read_text())['agent']['agent_session']['value']
    record=json.loads(self.runcli('--detach').stdout)
    launch=json.loads((self.root/'records'/record['id']/'launch.json').read_text())
    self.assertEqual(launch['agent_target']['provider'],provider)
    urllib.request.urlopen(urllib.request.Request(record['direct_url'],data=b'{}'))
    event=self.root/'records'/record['id']/'notification.json'
    self.until(lambda:event.exists() and json.loads(event.read_text()).get('delivery'))
    self.assertEqual(json.loads(event.read_text())['delivery'],'sent')
    args=json.loads(delivery.read_text());self.assertEqual(args[:3],['agent','prompt','w1:p1'])
    self.assertIn('Feedback is ready',args[3]);self.assertIn('--result '+record['id'],args[3])
    self.assertNotIn('?access=',args[3])
 def test_changed_session_or_pane_or_suspended_agent_never_receives_feedback(self):
  for change in ['session','terminal','shell','blocked']:
   with self.subTest(change=change):
    state,delivery=self.fake_agent();delivery.unlink(missing_ok=True)
    record=json.loads(self.runcli('--detach').stdout)
    current=json.loads(state.read_text())
    if change=='session':current['agent']['agent_session']['value']='other-session'
    elif change=='terminal':current['agent']['terminal_id']='replacement-terminal'
    elif change=='shell':current['process_info']['foreground_processes']=[{'name':'bash','argv':['bash']}]
    else:current['agent']['agent_status']='blocked'
    state.write_text(json.dumps(current))
    urllib.request.urlopen(urllib.request.Request(record['direct_url'],data=b'{}'))
    event=self.root/'records'/record['id']/'notification.json'
    self.until(lambda:event.exists() and json.loads(event.read_text()).get('delivery'))
    self.assertFalse(delivery.exists());self.assertEqual(json.loads(event.read_text())['delivery'],'durable-only')
 def test_unknown_parent_and_cancellation_never_claim_feedback_is_ready(self):
  state,delivery=self.fake_agent()
  self.env['PLANNOTATOR_DISCUSSION_SESSION_ID']='unrelated-session'
  record=json.loads(self.runcli('--detach').stdout)
  self.assertIsNone(json.loads((self.root/'records'/record['id']/'launch.json').read_text())['agent_target'])
  urllib.request.urlopen(urllib.request.Request(record['direct_url'],data=b'{}'))
  event=self.root/'records'/record['id']/'notification.json'
  self.until(lambda:event.exists() and json.loads(event.read_text()).get('delivery'))
  self.assertFalse(delivery.exists())
  self.fake_agent()
  record=json.loads(self.runcli('--detach').stdout)
  self.runcli('--cancel',record['id'])
  event=self.root/'records'/record['id']/'notification.json'
  self.until(lambda:event.exists() and json.loads(event.read_text()).get('delivery'))
  self.assertEqual(json.loads(event.read_text())['status'],'cancelled');self.assertFalse(delivery.exists())
 def test_agent_delivery_failure_preserves_saved_feedback(self):
  state,delivery=self.fake_agent();current=json.loads(state.read_text());current['exit_code']=1;state.write_text(json.dumps(current))
  record=json.loads(self.runcli('--detach').stdout)
  urllib.request.urlopen(urllib.request.Request(record['direct_url'],data=b'{}'))
  event=self.root/'records'/record['id']/'notification.json'
  self.until(lambda:event.exists() and json.loads(event.read_text()).get('delivery'))
  self.assertEqual(json.loads(event.read_text())['delivery'],'failed')
  self.assertEqual(self.runcli('--result',record['id']).returncode,0)
 def test_completion_callback_is_best_effort_and_has_no_shell(self):
  target=self.root/'callback.json'
  callback=[sys.executable,'-c',"import json,sys;from pathlib import Path;Path(sys.argv[1]).write_text(json.dumps(sys.argv[2:]))",str(target),'{review_id}','{result_file}','literal; $(not-a-command)']
  launched=self.runcli('--detach','--notify-command',json.dumps(callback));self.assertEqual(launched.returncode,0,launched.stderr)
  record=json.loads(launched.stdout);sid=record['id']
  urllib.request.urlopen(urllib.request.Request(record['direct_url'],data=b'{}'))
  self.until(target.exists)
  delivered=json.loads(target.read_text());self.assertEqual(delivered[0],sid);self.assertEqual(delivered[2],'literal; $(not-a-command)')
  self.assertTrue(Path(delivered[1]).is_file())
  record=json.loads(self.runcli('--detach','--notify-command','["/nonexistent-notifier"]' ).stdout)
  urllib.request.urlopen(urllib.request.Request(record['direct_url'],data=b'{}'))
  event=self.root/'records'/record['id']/'notification.json'
  self.until(lambda:event.exists() and json.loads(event.read_text()).get('delivery')=='failed')
  self.assertEqual(self.runcli('--result',record['id']).returncode,0)
 def test_invalid_output_and_startup_failure_are_retained_failures(self):
  self.env['FAKE_INVALID_OUTPUT']='1'
  record=json.loads(self.runcli('--detach').stdout)
  urllib.request.urlopen(urllib.request.Request(record['direct_url'],data=b'{}'))
  self.until(lambda:json.loads(self.runcli('--status',record['id']).stdout)['status']=='failed')
  self.assertEqual(self.runcli('--result',record['id']).returncode,1)
  self.assertIn('invalid output',(self.root/'records'/record['id']/'stdout.log').read_text())
  fake=self.root/'bin/plannotator'
  fake.write_text("#!/usr/bin/env python3\nimport sys\nprint('plannotator 0.28.20-references.29' if '--version' in sys.argv else 'startup failed')\nsys.exit(0 if '--version' in sys.argv else 1)\n")
  launched=self.runcli('--detach');self.assertEqual(launched.returncode,1)
  self.assertEqual(json.loads(launched.stdout)['status'],'failed')
 def test_detach_explicit_cancel_and_failed_exit_are_not_approval(self):
  a=json.loads(self.runcli('--detach').stdout);b=json.loads(self.runcli('--detach').stdout)
  self.runcli('--cancel',a['id']);self.until(lambda:json.loads(self.runcli('--status',a['id']).stdout)['status']=='cancelled')
  self.assertEqual(json.loads(self.runcli('--status',b['id']).stdout)['status'],'running')
  os.kill(b['review_pid'],signal.SIGTERM)
  self.until(lambda:json.loads(self.runcli('--status',b['id']).stdout)['status']=='failed')
  for sid in [a['id'],b['id']]:
   self.assertEqual(self.runcli('--result',sid).returncode,1);self.assertFalse((self.root/'records'/sid/'feedback.json').exists())
  self.assertNotEqual(self.runcli('--status','../bad').returncode,0)

class DataDirectoryTest(unittest.TestCase):
 def test_idle_deadline_uses_user_activity_and_gives_resumed_review_a_fresh_window(self):
  with tempfile.TemporaryDirectory() as directory:
   path=Path(directory);record={'created_at':100}
   self.assertFalse(durable.lifecycle.is_idle(path,record,100+72*3600-1))
   self.assertTrue(durable.lifecycle.is_idle(path,record,100+72*3600))
   (path/'activity.json').write_text(json.dumps({'last_activity_at':200}))
   self.assertFalse(durable.lifecycle.is_idle(path,record,100+72*3600))
   record['resumed_at']=100+72*3600
   self.assertFalse(durable.lifecycle.is_idle(path,record,record['resumed_at']+72*3600-1))
   self.assertTrue(durable.lifecycle.is_idle(path,record,record['resumed_at']+72*3600))
 def test_resolves_the_same_store_as_the_application(self):
  with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{},clear=True):
   home=Path(directory)
   with patch.object(Path,'home',return_value=home):
    self.assertEqual(durable.data_directory(),home/'.plannotator')
    os.environ['XDG_DATA_HOME']=str(home/'xdg')
    self.assertEqual(durable.data_directory(),home/'xdg'/'plannotator')
    (home/'.plannotator').mkdir()
    self.assertEqual(durable.data_directory(),home/'.plannotator')
    os.environ['PLANNOTATOR_DATA_DIR']=' ~/custom '
    self.assertEqual(durable.data_directory(),home/'custom')
    os.environ['PLANNOTATOR_DATA_DIR']='relative-data'
    self.assertEqual(durable.data_directory(),Path('relative-data').resolve())
    os.environ['PLANNOTATOR_DATA_DIR']=' '
    os.environ['XDG_DATA_HOME']='relative-xdg'
    (home/'.plannotator').rmdir()
    self.assertEqual(durable.data_directory(),home/'.plannotator')

if __name__=='__main__':
 import sys
 unittest.main()
