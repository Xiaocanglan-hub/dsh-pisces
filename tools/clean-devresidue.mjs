import path from 'node:path';
import { createStore } from '../lib/store.js';
import { rebuildIndex } from '../lib/search.js';
const ROOT='G:/DS工作区/pisces-home/data';
const CUT=673;
let store=await createStore({root:ROOT});
const rows=store.readAll();
console.log('before', rows.length);
const keep=rows.filter(e=>Number(e.seq)<CUT);
console.log('keep', keep.length, 'drop', rows.length-keep.length);
const last=keep[keep.length-1];
const db=store;
// 用 store 的 append 不能改已有行；直接 SQL 删尾部再 rechain
import { DatabaseSync } from 'node:sqlite';
// 先关 store 再改
store.close();
const raw=new DatabaseSync(path.join(ROOT,'events.db'));
raw.exec('PRAGMA busy_timeout = 8000');
raw.prepare('DELETE FROM events WHERE seq >= ?').run(CUT);
raw.close();
store=await createStore({root:ROOT});
const n=store.rechain();
const v=store.verify();
const rebuilt=rebuildIndex(store);
console.log('rechain',n,'count',store.count(),'verify',JSON.stringify(v),'index',JSON.stringify(rebuilt));
const rs=store.readAll();
console.log('last', rs[rs.length-1]?.seq, rs[rs.length-1]?.type, rs[rs.length-1]?.source, String(rs[rs.length-1]?.text||'').slice(0,40));
store.close();