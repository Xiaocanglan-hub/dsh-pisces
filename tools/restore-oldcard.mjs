import { createStore } from '../lib/store.js';
import { importSoulBundle } from '../lib/export.js';
const ROOT='G:/DS工作区/pisces-home/data';
const BUNDLE='G:/DS工作区/dsh-pisces/exports/soul-2026-11-09-2215.soul.json';
const store=await createStore({root:ROOT});
const r=await importSoulBundle({file:BUNDLE,store,root:ROOT});
console.log(JSON.stringify({ok:r.ok,imported:r.imported,skipped:r.skipped,failed:r.failed,diary:r.diary,card:r.card,chain:r.chain},null,1));
console.log('count',store.count(),'verify',JSON.stringify(store.verify()));
store.close();