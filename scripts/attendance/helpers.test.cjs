const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),path=require('path');
const root=path.resolve(__dirname,'../..');
const esbuild=require(path.join(root,'client/node_modules/esbuild'));
const source=fs.readFileSync(path.join(root,'supabase/functions/_shared/attendance-engine.ts'),'utf8');
const moduleObject={exports:{}};
vm.runInNewContext(esbuild.transformSync(source,{loader:'ts',format:'cjs'}).code,{module:moduleObject,exports:moduleObject.exports,require:()=>({}),Date});
const {isoDay:workDate,validDay:validDate}=moduleObject.exports;
test('IST work date crosses midnight independently of UTC day',()=>{
 assert.equal(workDate(new Date('2026-08-31T18:29:59Z')),'2026-08-31');
 assert.equal(workDate(new Date('2026-08-31T18:30:00Z')),'2026-09-01');
 assert.equal(workDate(new Date('2026-12-31T20:00:00Z')),'2027-01-01');
});
test('Calendar dates reject overflow and malformed values',()=>{
 for(const value of ['2026-02-29','2026-02-31','2026-13-01','tomorrow',null])assert.equal(validDate(value),false);
 assert.equal(validDate('2028-02-29'),true);
});
