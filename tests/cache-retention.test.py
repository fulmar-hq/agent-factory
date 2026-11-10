import importlib.util, json, os, pathlib, sqlite3, subprocess, tempfile, unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('cleaner',pathlib.Path(__file__).parents[1]/'scripts/cache-retention.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Safety(unittest.TestCase):
 def setUp(self):
  scratch=pathlib.Path(__file__).parents[1]/'.factory-tmp';scratch.mkdir(exist_ok=True)
  self.root=pathlib.Path(tempfile.mkdtemp(dir=scratch)).resolve();self.repo=self.root/'workspaces'/'a';self.repo.mkdir(parents=True)
  self.git('init','-q');self.git('config','user.name','Fixture');self.git('config','user.email','fixture@example.test')
  (self.repo/'.gitignore').write_text('node_modules/\n.next/\n.factory-tmp/\n')
  self.git('add','.gitignore');self.git('-c','commit.gpgsign=false','commit','-qm','fixture')
  self.db=sqlite3.connect(self.root/'controller.sqlite');self.db.executescript('create table sessions(id text,status text,pid integer);create table kv(key text,value text);')
  self.db.execute("insert into sessions values('a','waiting-browser',null)");self.db.execute('insert into kv values(?,?)',('cleanup-evidence:a',json.dumps({'verified':True})));self.db.commit()
  self.cache=self.repo/'node_modules';self.cache.mkdir();(self.cache/'generated.js').write_text('regenerable');(self.cache/'result.jsonl').write_text('evidence')
 def git(self,*args):
  return subprocess.check_output(['git','-C',str(self.repo),*args],stderr=subprocess.STDOUT)
 def test_waiting_browser_preserves_evidence_source_and_git(self):
  (self.repo/'dirty.txt').write_text('uncommitted')
  with patch.object(m,'quiet',return_value=True):m.sweep(self.root,True)
  self.assertFalse((self.cache/'generated.js').exists());self.assertEqual((self.cache/'result.jsonl').read_text(),'evidence')
  self.assertTrue((self.repo/'.factory-tmp/dependencies-evicted.jsonl').exists());self.assertEqual((self.repo/'dirty.txt').read_text(),'uncommitted');self.git('cat-file','-e','HEAD')
 def test_live_or_unknown_cleanup_and_process_references_refuse(self):
  for status,proof in [('running',True),('finished',False)]:
   self.db.execute('update sessions set status=?',(status,));self.db.execute('update kv set value=?',(json.dumps({'verified':proof}),));self.db.commit()
   with patch.object(m,'quiet',return_value=True):m.sweep(self.root,True)
   self.assertTrue((self.cache/'generated.js').exists())
  self.db.execute("update sessions set status='finished'");self.db.execute('update kv set value=?',(json.dumps({'verified':True}),));self.db.commit()
  with patch.object(m,'quiet',return_value=False):m.sweep(self.root,True)
  self.assertTrue((self.cache/'generated.js').exists())
 def test_staged_removal_and_symlink_roots_refuse(self):
  self.git('add','-f','node_modules/generated.js');self.git('-c','commit.gpgsign=false','commit','-qm','tracked fixture');self.git('rm','--cached','node_modules/generated.js')
  self.assertFalse(m.eligible(self.repo,self.cache))
  link=self.repo/'.next';link.symlink_to(self.cache,target_is_directory=True);self.assertFalse(m.eligible(self.repo,link))
 def test_unknown_probe_and_dry_run_preserve_everything(self):
  with patch.object(m,'quiet',side_effect=RuntimeError('unknown process evidence')):m.sweep(self.root,True)
  with patch.object(m,'quiet',return_value=True):m.sweep(self.root,False)
  self.assertTrue((self.cache/'generated.js').exists())
 def test_incomplete_process_inventories_refuse(self):
  uid=os.getuid();ps=f'{uid} 4242 S python3\n'
  complete='p4242\ncpython3\nfcwd\nn/other\nf0\nn/dev/null\n'
  def run(files,process=ps):
   with patch.object(m,'command',side_effect=[process,files,process]):return m.quiet([self.repo])
  self.assertTrue(run(complete))
  for files in ['p4242\nn/proc/4242/fd (opendir: Permission denied)\n','p4242\ncpython3\nf0\nn/dev/null\n',complete[:-1],complete.replace('n/dev/null','n/proc/fd (stat: Permission denied)'),complete.replace('fcwd\nn/other\n','')]:
   with self.assertRaises(RuntimeError):run(files)
  with patch.object(m,'command',side_effect=['partial\n']):
   with self.assertRaises(RuntimeError):m.quiet([self.repo])
  from subprocess import CompletedProcess
  with patch.object(m.subprocess,'run',return_value=CompletedProcess([],0,'valid-looking output','warning: incomplete inventory')):
   with self.assertRaises(RuntimeError):m.command(['lsof'])
 def test_hardlinked_marker_cannot_modify_source(self):
  scratch=self.repo/'.factory-tmp';scratch.mkdir();source=self.repo/'dirty-source';source.write_text('preserve')
  os.link(source,scratch/'dependencies-evicted.jsonl')
  with patch.object(m,'quiet',return_value=True):m.sweep(self.root,True)
  self.assertEqual(source.read_text(),'preserve');self.assertTrue((self.cache/'generated.js').exists())
 def test_special_cache_files_refuse(self):
  os.mkfifo(self.cache/'unknown-pipe');self.assertFalse(m.eligible(self.repo,self.cache))
 def test_nested_git_refuses_and_links_never_follow(self):
  target=self.repo/'outside';target.write_text('keep');(self.cache/'link').symlink_to(target)
  self.assertTrue(m.eligible(self.repo,self.cache));m.remove(self.cache);self.assertEqual(target.read_text(),'keep')
  (self.cache/'.git').mkdir();self.assertFalse(m.eligible(self.repo,self.cache))

if __name__=='__main__':unittest.main()
