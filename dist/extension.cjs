"use strict";var me=Object.create;var _=Object.defineProperty;var ge=Object.getOwnPropertyDescriptor;var he=Object.getOwnPropertyNames;var be=Object.getPrototypeOf,ye=Object.prototype.hasOwnProperty;var we=(e,t)=>{for(var n in t)_(e,n,{get:t[n],enumerable:!0})},z=(e,t,n,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of he(t))!ye.call(e,o)&&o!==n&&_(e,o,{get:()=>t[o],enumerable:!(r=ge(t,o))||r.enumerable});return e};var q=(e,t,n)=>(n=e!=null?me(be(e)):{},z(t||!e||!e.__esModule?_(n,"default",{value:e,enumerable:!0}):n,e)),xe=e=>z(_({},"__esModule",{value:!0}),e);var st={};we(st,{activate:()=>rt,deactivate:()=>ot});module.exports=xe(st);var fe=q(require("vscode"),1);var $=q(require("vscode"),1);var y=require("node:fs/promises"),h=require("node:path"),W=/===\s*FILE:\s*(.+?)\s*===\r?\n([\s\S]*?)\r?\n===\s*END FILE\s*===/g;function U(e){let t=[],n;for(W.lastIndex=0;n=W.exec(e);){let r=(n[1]??"").trim(),o=n[2]??"";o=ke(o),r&&t.push({path:r,contents:o.replace(/\s+$/,"")+`
`})}return t}function ke(e){let n=e.replace(/^\s+/,"").replace(/\s+$/,"").match(/^```[^\n]*\n([\s\S]*?)\n```$/);return n?n[1]:e}async function D(e,t,n){let r=[];for(let o of t){let s=Ee(o.path);if(!s){n?.(`skipped unsafe path ${o.path}`,o.path);continue}let a=(0,h.join)(e,s),u=await ve(a);await(0,y.mkdir)((0,h.dirname)(a),{recursive:!0}),await(0,y.writeFile)(a,o.contents,"utf8"),r.push({label:s,path:a,kind:"generated"}),n?.(`${u?"updated":"created"} ${s}`,a)}return r}async function Y(e,t,n,r){let o=(0,h.join)(e,".orchestrator",Me());await(0,y.mkdir)((0,h.join)(o,"raw"),{recursive:!0}),await(0,y.writeFile)((0,h.join)(o,"plan.json"),JSON.stringify(t,null,2),"utf8"),await(0,y.writeFile)((0,h.join)(o,"report.md"),r,"utf8");for(let s of n)await(0,y.writeFile)((0,h.join)(o,"raw",`${$e(s.id)}.md`),s.text||s.error||"","utf8");return o}async function ve(e){try{return await(0,y.stat)(e),!0}catch{return!1}}function Ee(e){let t=e.replace(/\\/g,"/").replace(/^~\//,"").trim();(0,h.isAbsolute)(t)&&(t=t.replace(/^\/+/,""));let n=(0,h.normalize)(t);if(!(!n||n.startsWith("..")||n.split(h.sep).includes("..")))return n}function $e(e){return e.replace(/[^A-Za-z0-9._-]/g,"_").replace(/^_+/,"")||"artifact"}function Me(){return new Date().toISOString().replace(/[:.]/g,"-")}var k=[{adapter:"claude",id:"haiku",label:"Claude Haiku 4.5",efforts:["low","medium"],weight:2,use:"trivial code, quick edits, simple prose"},{adapter:"claude",id:"sonnet",label:"Claude Sonnet 5",efforts:["low","medium","high","xhigh","max"],weight:6,use:"ordinary implementation needing care"},{adapter:"claude",id:"claude-sonnet-4-6",label:"Claude Sonnet 4.6",efforts:["low","medium","high","xhigh","max"],weight:5,use:"ordinary implementation (prior sonnet)"},{adapter:"claude",id:"opus",label:"Claude Opus 5",efforts:["low","medium","high","xhigh","max"],weight:10,use:"hardest work: concurrency, algorithms, security, design"},{adapter:"claude",id:"claude-opus-4-8",label:"Claude Opus 4.8",efforts:["low","medium","high","xhigh","max"],weight:9,use:"hard work (prior opus)"},{adapter:"codex",id:"gpt-5.4-mini",label:"GPT-5.4-Mini",efforts:["low","medium","high","xhigh"],weight:3,use:"cheap, fast, boilerplate and docs"},{adapter:"codex",id:"gpt-5.6-terra",label:"GPT-5.6-Terra",efforts:["low","medium","high","xhigh","max","ultra"],weight:7,use:"balanced agentic coding for everyday work"},{adapter:"codex",id:"gpt-5.6-luna",label:"GPT-5.6-Luna",efforts:["low","medium","high","xhigh","max"],weight:7,use:"strong general coding, alternative to Terra"},{adapter:"codex",id:"gpt-5.5",label:"GPT-5.5",efforts:["low","medium","high","xhigh"],weight:6,use:"general coding"}];function b(e,t){return k.find(n=>n.adapter===e&&n.id===t)}function I(e,t){let n=(r,o,s)=>{let a=b(r,o)??k[0];return{entry:a,effort:w(a,s)}};return e==="review"?n("claude","opus","max"):t==="hard"?n("claude","opus","high"):t==="standard"?n("codex","gpt-5.6-terra","medium"):e==="docs"?n("codex","gpt-5.4-mini","low"):n("claude","haiku","low")}function O(e,t){return k.filter(r=>r.adapter===e).slice().sort((r,o)=>Math.abs(r.weight-t)-Math.abs(o.weight-t))[0]??k[0]}function w(e,t){if(e.efforts.includes(t))return t;let n=["low","medium","high","xhigh","max","ultra"],r=n.indexOf(t);for(let o=r;o>=0;o--)if(e.efforts.includes(n[o]))return n[o];return e.efforts[0]??"medium"}function J(){return k.map(e=>`- ${e.adapter}/${e.id} (${e.label}) \u2014 ${e.use}. efforts: ${e.efforts.join("/")}`).join(`
`)}var G=require("node:child_process"),S=require("node:fs/promises"),Q=require("node:os"),B=require("node:path");function Z(e,t,n){return new Promise(r=>{let o=Date.now(),s="",a="",u=!1,i;try{i=(0,G.spawn)(e,t,{cwd:n.cwd,env:n.env})}catch(f){r({code:null,stdout:"",stderr:"",timedOut:!1,spawnError:String(f),durationMs:0});return}let c=setTimeout(()=>{u=!0,i.kill("SIGKILL")},n.timeoutMs),l=()=>i.kill("SIGKILL");n.signal?.addEventListener("abort",l,{once:!0}),i.stdout.on("data",f=>{let d=f.toString();s+=d,n.onStdout?.(d)}),i.stderr.on("data",f=>{let d=f.toString();a+=d,n.onStderr?.(d)}),i.on("error",f=>{clearTimeout(c),r({code:null,stdout:s,stderr:a,timedOut:u,spawnError:String(f),durationMs:Date.now()-o})}),i.on("close",f=>{clearTimeout(c),n.signal?.removeEventListener("abort",l),r({code:f,stdout:s,stderr:a,timedOut:u,durationMs:Date.now()-o})}),n.stdin!==void 0&&(i.stdin.write(n.stdin),i.stdin.end())})}function v(e){let t=e.trim();try{return JSON.parse(t)}catch{}let n=t.search(/[{[]/);if(n!==-1)for(let r=t.length;r>n;r--){let o=t.slice(n,r);if(o.endsWith("}")||o.endsWith("]"))try{return JSON.parse(o)}catch{}}}async function C(e){let t=!e.schema,n=["--print","--model",e.model,"--output-format",t?"stream-json":"json","--max-turns","8","--permission-mode","dontAsk","--disallowedTools","Bash","Read","Edit","Write","Glob","Grep","WebFetch","WebSearch"];e.effort&&n.push("--effort",e.effort),t&&n.push("--verbose","--include-partial-messages"),e.system&&n.push("--system-prompt",e.system),e.schema&&n.push("--json-schema",JSON.stringify(e.schema)),e.onEvent?.({type:"log",text:ee("claude",e.model,e.effort,e.prompt.length)});let r,o="";t&&(r=Se(e.onEvent));let s=await Z(e.bin,n,{cwd:e.cwd,stdin:e.prompt,env:e.env,timeoutMs:e.timeoutMs,...e.signal?{signal:e.signal}:{},...r?{onStdout:d=>r.accept(d)}:{},onStderr:d=>{o=x(o+d,p=>{F(p)||e.onEvent?.({type:"log",text:p})})}});if(r&&r.flush(),x(o+`
`,d=>{F(d)||e.onEvent?.({type:"log",text:d})}),s.spawnError)return te(e.model,`could not run ${e.bin}: ${s.spawnError}`);if(t&&r){let d=r.finalText.trim()||r.accumulatedText.trim()||s.stdout.trim(),p=r.actualModel||e.model,m=r.inputTokens,g=r.outputTokens;return s.timedOut?{ok:!1,text:"",model:p,inputTokens:m,outputTokens:g,durationMs:s.durationMs,error:`timed out after ${e.timeoutMs}ms`}:r.error?{ok:!1,text:d,model:p,inputTokens:m,outputTokens:g,durationMs:s.durationMs,error:r.error}:s.code!==0?{ok:!1,text:d,model:p,inputTokens:m,outputTokens:g,durationMs:s.durationMs,error:s.stderr.slice(0,500)||`exited with code ${s.code}`}:{ok:!0,text:d,model:p,inputTokens:m,outputTokens:g,durationMs:s.durationMs}}let a=v(s.stdout),u=a?.result??s.stdout,i=a?.usage?.input_tokens??0,c=a?.usage?.output_tokens??0,l=Pe(a?.modelUsage,e.model);return s.timedOut?{ok:!1,text:"",model:l,inputTokens:i,outputTokens:c,durationMs:s.durationMs,error:`timed out after ${e.timeoutMs}ms`}:a?.is_error?{ok:!1,text:"",model:l,inputTokens:i,outputTokens:c,durationMs:s.durationMs,error:a.error||a.result||"claude reported an error"}:s.code!==0?{ok:!1,text:"",model:l,inputTokens:i,outputTokens:c,durationMs:s.durationMs,error:s.stderr.slice(0,500)||`exited with code ${s.code}`}:{ok:!0,text:e.schema&&a?.structured_output!==void 0?JSON.stringify(a.structured_output):u,model:l,inputTokens:i,outputTokens:c,durationMs:s.durationMs}}async function X(e){let t=await(0,S.mkdtemp)((0,B.join)((0,Q.tmpdir)(),"orch-mvp-codex-")),n=(0,B.join)(t,"last.txt"),r=e.model;try{let o=["exec","--json","--model",r,"-c",`model_reasoning_effort=${e.effort}`,"--sandbox","read-only","--cd",e.cwd,"--skip-git-repo-check","--output-last-message",n,"-"];e.onEvent?.({type:"log",text:ee("codex",e.model,e.effort,e.prompt.length)});let s="",a="",u=0,i=0,c,l=await Z(e.bin,o,{cwd:e.cwd,stdin:e.prompt,env:e.env,timeoutMs:e.timeoutMs,...e.signal?{signal:e.signal}:{},onStdout:p=>{s=x(s+p,m=>{let g=v(m);if(!g)return;let M=K(g,e.onEvent);(M.inputTokens||M.outputTokens)&&(u=M.inputTokens,i=M.outputTokens),M.error&&(c=M.error)})},onStderr:p=>{a=x(a+p,m=>{F(m)||e.onEvent?.({type:"log",text:m})})}});if(x(s+`
`,p=>{let m=v(p);if(!m)return;let g=K(m,e.onEvent);(g.inputTokens||g.outputTokens)&&(u=g.inputTokens,i=g.outputTokens),g.error&&(c=g.error)}),x(a+`
`,p=>{F(p)||e.onEvent?.({type:"log",text:p})}),l.spawnError)return te(r,`could not run ${e.bin}: ${l.spawnError}`);let f="";try{f=(await(0,S.readFile)(n,"utf8")).trim()}catch{}for(let p of l.stdout.split(`
`)){let m=v(p);m&&(m.type==="turn.completed"&&m.usage&&(u=m.usage.input_tokens??0,i=m.usage.output_tokens??0),m.type==="turn.failed"?c=A(m.error?.message)??"codex turn failed":m.type==="error"&&(c=A(m.message)??"codex error"))}let d=r==="default"?"codex (account default)":r;return l.timedOut?{ok:!1,text:"",model:d,inputTokens:u,outputTokens:i,durationMs:l.durationMs,error:`timed out after ${e.timeoutMs}ms`}:c?{ok:!1,text:"",model:d,inputTokens:u,outputTokens:i,durationMs:l.durationMs,error:c}:l.code!==0?{ok:!1,text:"",model:d,inputTokens:u,outputTokens:i,durationMs:l.durationMs,error:l.stderr.slice(0,500)||`exited with code ${l.code}`}:{ok:!0,text:f||l.stdout,model:d,inputTokens:u,outputTokens:i,durationMs:l.durationMs}}finally{await(0,S.rm)(t,{recursive:!0,force:!0}).catch(()=>{})}}function A(e){if(!e)return;let t=v(e);return t?.error?.message||t?.message||e}function Se(e){let t={buffer:"",finalText:"",accumulatedText:"",actualModel:"",inputTokens:0,outputTokens:0,accept(n){t.buffer=x(t.buffer+n,r=>{let o=v(r);o&&V(o,t,e)})},flush(){t.buffer=x(t.buffer+`
`,n=>{let r=v(n);r&&V(r,t,e)})}};return t}function V(e,t,n){if(e.type!=="system"){if(e.type==="assistant"){let r=Te(e.message?.content);if(r){let s=r.startsWith(t.accumulatedText)?r.slice(t.accumulatedText.length):r;t.accumulatedText=r.startsWith(t.accumulatedText)?r:t.accumulatedText+r,s&&n?.({type:"delta",text:s})}t.actualModel=e.message?.model??e.model??t.actualModel;let o=e.message?.usage;o&&(t.inputTokens=o.input_tokens??t.inputTokens,t.outputTokens=o.output_tokens??t.outputTokens);return}e.type==="result"&&(t.finalText=e.result??t.finalText,t.actualModel=e.model??t.actualModel,e.usage&&(t.inputTokens=e.usage.input_tokens??t.inputTokens,t.outputTokens=e.usage.output_tokens??t.outputTokens,n?.({type:"usage",inputTokens:t.inputTokens,outputTokens:t.outputTokens})),e.is_error&&(t.error=e.error||e.result||"claude reported an error"))}}function K(e,t){let n=e.usage?.input_tokens??0,r=e.usage?.output_tokens??0;e.usage&&t?.({type:"usage",inputTokens:n,outputTokens:r});let o=Ce(e);o?t?.({type:"delta",text:o}):e.type&&Re(e.type)&&t?.({type:"log",text:`Codex: ${Le(e.type)}`});let s;return e.type==="turn.failed"?s=A(typeof e.error=="string"?e.error:e.error?.message)??"codex turn failed":e.type==="error"&&(s=A(typeof e.error=="string"?e.error:e.error?.message??e.message)??"codex error"),{inputTokens:n,outputTokens:r,...s?{error:s}:{}}}function x(e,t){let n=e.split(/\r?\n/),r=n.pop()??"";for(let o of n){let s=o.trim();s&&t(s)}return r}function Te(e){return typeof e=="string"?e:Array.isArray(e)?e.map(t=>{if(!t||typeof t!="object")return"";let n=t;return typeof n.text=="string"?n.text:""}).join(""):""}function Ce(e){if(typeof e.delta=="string")return e.delta;if(e.type==="item.completed"&&e.item&&typeof e.item=="object"){let t=e.item;if(t.type==="agent_message"&&typeof t.text=="string")return t.text}return e.type?.includes("message")&&typeof e.text=="string"?e.text:e.type?.includes("message")&&typeof e.message=="string"?e.message:""}function Re(e){return e.includes("exec")||e.includes("patch")||e==="turn.failed"}function F(e){return/models cache|base_instructions|codex_models_manager|^\s*$/.test(e)}function Le(e){return e.replace(/[._-]+/g," ")}function Pe(e,t){if(!e)return t;let n=t,r=0;for(let[o,s]of Object.entries(e)){let a=s,u=a?.outputTokens??a?.output_tokens??0;u>r&&(r=u,n=o)}return n}function ee(e,t,n,r){let o=b(e,t)?.label??`${e==="claude"?"Claude":"Codex"} ${t}`,s=n?` \xB7 ${n} effort`:"",a=r>=1e3?`${(r/1e3).toFixed(1)}k`:String(r);return`\u25B8 ${o}${s} \xB7 ${a} chars context`}function te(e,t){return{ok:!1,text:"",model:e,inputTokens:0,outputTokens:0,durationMs:0,error:t}}var _e=20;function ne(e,t){return e.known&&(!!e.reachedLimit||e.headroom!==void 0&&e.headroom<t)}function re(e,t,n,r){let o=Oe(e,t,n);return Ae(o,t,r)}function Oe(e,t,n){let r=I(e,t),o=l=>({adapter:r.entry.adapter,model:r.entry.id,effort:r.effort,note:`${l} Defaulted to ${r.entry.label} at ${r.effort}.`});if(!n?.adapter||!n.model)return o("No valid model choice from main model.");let s=b(n.adapter,n.model);if(!s)return o(`Invalid model choice ${n.adapter}/${n.model}.`);if(e==="review"){let l=I(e,t);return{adapter:l.entry.adapter,model:l.entry.id,effort:l.effort,note:"Review work is always routed to the strongest verifier."}}if(t==="hard"&&s.weight<7)return o(`Main model chose ${s.label}, but hard work needs a stronger model.`);let a=n.effort??r.effort,u=w(s,a),i=u===a?"":` Effort clamped from ${a} to ${u}.`,c=n.reason?.trim()?` ${n.reason.trim()}`:"";return{adapter:s.adapter,model:s.id,effort:u,note:`Main model chose ${s.label} at ${u}.${c}${i}`}}function Ae(e,t,n){if(!n)return e;let r=n.softFloor??_e,o=e.adapter==="claude"?n.claude:n.codex,s=e.adapter==="claude"?"codex":"claude",a=s==="claude"?n.claude:n.codex;if(!ne(o,r))return e;if(!(a.known?!ne(a,r):!!o.reachedLimit)){let p=o.reachedLimit?"exhausted":`low (${o.headroom}% left)`;return{...e,note:`${e.note} ${e.adapter} ${p} but ${s} is no better \u2014 keeping ${e.adapter}.`}}let i=b(e.adapter,e.model),c=O(s,i?.weight??(t==="hard"?9:5)),l=w(c,e.effort),f=o.reachedLimit?"out of quota":`low on quota (${o.headroom}% left, floor ${r}%)`,d=a.known&&a.headroom!==void 0?` (${a.headroom}% left)`:"";return{adapter:c.adapter,model:c.id,effort:l,note:`${e.adapter} ${f} \u2192 rerouted to ${c.label}${d} at ${l}.`}}var Fe=`You are the orchestrator. You split a software request into the concrete deliverables it asks for, so each can be handed to a different model.

Rules:
- Produce between 1 and 6 subtasks. Each subtask is a REAL DELIVERABLE the request asks for (a module, a class, a test file, a docs section) \u2014 never a process step.
- NEVER create meta subtasks such as "inspect the workspace", "check permissions", "set up the project", "prepare a patch", or "read existing files". You are generating new content from the request; there is nothing to inspect.
- Split by deliverable. If the request lists parts (1)(2)(3), those are your subtasks.
- Set dependsOn only for genuine ordering (tests depend on the code they test; a README depends on the thing it documents). Independent parts must have no dependency so they run in parallel.
- Mark difficulty honestly \u2014 it decides which model runs it:
  - "hard": concurrency, thread-safety, locking, algorithms, security, performance, or a real design decision. THREAD-SAFE / CONCURRENT / RACE-FREE work is always "hard".
  - "standard": ordinary implementation requiring care but no deep reasoning.
  - "mechanical": boilerplate, simple glue, docstrings, a README, trivial tests.
- kind is one of: code, test, docs, analysis, review.
- Choose adapter/model/effort for each subtask from this verified catalog only:
${J()}
- Use Opus/high-or-above or Codex Terra/Luna high-or-above for hard work. Use cheaper models for mechanical work.
- The app will validate your choices and replace invalid/underpowered picks.

Return only the JSON the schema asks for.`,He=k.map(e=>e.id),Ne={name:"decomposition",schema:{type:"object",properties:{subtasks:{type:"array",minItems:1,maxItems:6,items:{type:"object",properties:{id:{type:"string"},title:{type:"string"},goal:{type:"string"},kind:{type:"string",enum:["code","test","docs","analysis","review"]},difficulty:{type:"string",enum:["mechanical","standard","hard"]},dependsOn:{type:"array",items:{type:"string"}},route:{type:"object",properties:{adapter:{type:"string",enum:["claude","codex"]},model:{type:"string",enum:He},effort:{type:"string",enum:["low","medium","high","xhigh","max","ultra"]},reason:{type:"string"}},required:["adapter","model","effort","reason"],additionalProperties:!1}},required:["id","title","goal","kind","difficulty","dependsOn","route"],additionalProperties:!1}}},required:["subtasks"],additionalProperties:!1}};async function oe(e,t,n,r,o){let s=await C({bin:t.bin,model:t.model,effort:t.effort,system:Fe,prompt:`REQUEST:
${e}`,schema:Ne.schema,cwd:t.cwd,env:t.env,timeoutMs:t.timeoutMs,...o?{onEvent:o}:{},...r?{signal:r}:{}});if(!s.ok)throw new Error(`Analysis failed on ${t.model}: ${s.error??"no output"}`);let u=Be(s.text)?.subtasks??[];u.length===0&&u.push({id:"task",title:"Complete the request",goal:e,kind:"code",difficulty:"standard",dependsOn:[],route:{adapter:"codex",model:"gpt-5.6-terra",effort:"medium",reason:"fallback route for the whole request"}});let i=new Set(u.map(l=>l.id)),c=u.map(l=>{let f=re(l.kind,l.difficulty,De(l.route),n);return{id:l.id,title:l.title,goal:l.goal,kind:l.kind,difficulty:l.difficulty,dependsOn:l.dependsOn.filter(d=>i.has(d)&&d!==l.id),adapter:f.adapter,model:f.model,effort:f.effort,routingNote:f.note}});return{prompt:e,subtasks:c}}var Ue=`You are the orchestrator reviewing files that worker models have ALREADY written to disk. Your job is a quick integration review \u2014 NOT to re-write or re-print the files.

- Check the files fit together: imports resolve, names/signatures match across files, the docs match the code.
- Write a SHORT report (a few bullet points): what was built, and whether it is consistent.
- ONLY if a file genuinely needs a fix for consistency, output the corrected file \u2014 and only that file \u2014 wrapped exactly as:
  ===FILE: <path>===
  <corrected full contents>
  ===END FILE===
- Do NOT re-emit files that are already correct. Most reviews need no file blocks at all. Be concise \u2014 this step must stay cheap.`;async function se(e,t,n,r,o){let s=t.filter(i=>i.ok&&i.text.trim());if(s.length===0)return"_No subtask produced output._";if(s.length===1)return`Single deliverable produced by ${s[0].adapter}/${s[0].model}. No cross-file integration needed.`;let a=s.map(i=>`### ${e.subtasks.find(l=>l.id===i.id)?.title??i.id}  (${i.adapter}/${i.model})
${i.text}`).join(`

---

`),u=await C({bin:n.bin,model:n.model,effort:n.effort,system:Ue,prompt:`ORIGINAL REQUEST:
${e.prompt}

FILES THE WORKERS WROTE (for your review \u2014 do not reprint them):

${a}`,cwd:n.cwd,env:n.env,timeoutMs:n.timeoutMs,...o?{onEvent:o}:{},...r?{signal:r}:{}});return u.ok?u.text:`_Integration review unavailable (${u.error??"failed"}). Files were still written by the workers._`}function De(e){if(!e||typeof e!="object")return;let t=e;return{...t.adapter==="claude"||t.adapter==="codex"?{adapter:t.adapter}:{},...typeof t.model=="string"?{model:t.model}:{},...Ie(t.effort)?{effort:t.effort}:{},...typeof t.reason=="string"?{reason:t.reason}:{}}}function Ie(e){return e==="low"||e==="medium"||e==="high"||e==="xhigh"||e==="max"||e==="ultra"}function Be(e){try{return JSON.parse(e)}catch{let t=e.match(/\{[\s\S]*\}/);if(t)try{return JSON.parse(t[0])}catch{}return}}var ie=`You are one worker in a pipeline. Produce ONLY the file(s) this subtask must deliver \u2014 no preamble, no plan, no restating the task, no explanation outside the files.

Output EVERY file wrapped EXACTLY like this, and nothing else:
===FILE: <relative/path/with/extension>===
<the complete file contents>
===END FILE===

Rules:
- Use the real intended filename and extension (e.g. rate_limiter.py, tests/test_x.py, README.md).
- Put the raw file contents between the markers. Do NOT wrap them in triple-backtick fences.
- A documentation deliverable is still a file (===FILE: README.md===).
- If you depend on earlier files, stay consistent with them (same names, same imports).
- Emit one ===FILE:...===/===END FILE=== block per file. Output nothing before the first marker or after the last.`;async function de(e,t){let n=new Map,r=We(e.subtasks);for(let o of r)await Promise.all(o.map(async s=>{let a=e.subtasks.find(i=>i.id===s);t.onEvent?.({type:"start",subtask:a});let u=await je(e,a,n,t);n.set(s,u),t.onEvent?.({type:"done",result:u})}));return e.subtasks.map(o=>n.get(o.id)).filter(Boolean)}async function je(e,t,n,r){let o=t.dependsOn.map(i=>n.get(i)).filter(i=>!!(i&&i.ok)),s=o.length>0?`

OUTPUT OF EARLIER SUBTASKS YOU DEPEND ON:

${o.map(i=>`--- ${i.id} ---
${i.text.slice(0,4e3)}`).join(`

`)}`:"",a=`OVERALL REQUEST (for context):
${e.prompt}

YOUR SUBTASK: ${t.title}
${t.goal}${s}`,u=await ae(t.adapter,t.model,t.effort,a,t,r);if(!u.ok&&ze(u.error)&&!r.signal?.aborted){let i=t.adapter==="claude"?"codex":"claude",c=b(t.adapter,t.model)?.weight??5,l=O(i,c),f=w(l,t.effort);return r.onEvent?.({type:"log",subtask:t,text:`${t.adapter}/${t.model} hit its usage limit \u2192 retrying on ${l.adapter}/${l.id} (${f})`}),ae(l.adapter,l.id,f,a,t,r)}return u}async function ae(e,t,n,r,o,s){let a={id:o.id,adapter:e,model:t,effort:n,usd:0},u={cwd:s.cwd,env:s.env,timeoutMs:s.timeoutMs,onEvent:c=>qe(c,o,s),...s.signal?{signal:s.signal}:{}},i=e==="codex"?await X({bin:s.codexBin,model:t,effort:n,prompt:`${ie}

${r}`,...u}):await C({bin:s.claudeBin,model:t,effort:n,system:ie,prompt:r,...u});return{...a,model:i.model,ok:i.ok,text:i.text,inputTokens:i.inputTokens,outputTokens:i.outputTokens,durationMs:i.durationMs,...i.error?{error:i.error}:{}}}function ze(e){return e?/usage limit|quota|rate.?limit|not supported when using|too many requests|429/i.test(e):!1}function qe(e,t,n){e.type==="log"?n.onEvent?.({type:"log",subtask:t,text:e.text}):e.type==="delta"?n.onEvent?.({type:"delta",subtask:t,text:e.text}):n.onEvent?.({type:"usage",subtask:t,inputTokens:e.inputTokens,outputTokens:e.outputTokens})}function We(e){let t=new Map(e.map(r=>[r.id,new Set(r.dependsOn.filter(o=>e.some(s=>s.id===o)))])),n=[];for(;t.size>0;){let r=[...t.entries()].filter(([,o])=>o.size===0).map(([o])=>o);if(r.length===0){n.push([...t.keys()]);break}n.push(r);for(let o of r)t.delete(o);for(let o of t.values())for(let s of r)o.delete(s)}return n}var ue=require("node:child_process"),T,R="__ORCH_ENV__";async function Ye(){if(T)return T;let e=process.env.SHELL||"/bin/zsh",t=`builtin echo ${R}; env; builtin echo ${R}`;for(let n of[["-lic",t],["-lc",t]])try{let r=await Je(e,n),o=Ve(r);if(Object.keys(o).length>0)return T=o,T}catch{}return T={},T}function Je(e,t){return new Promise((n,r)=>{let o=(0,ue.spawn)(e,t,{stdio:["ignore","pipe","ignore"]}),s="",a=setTimeout(()=>o.kill(),8e3);o.stdout.on("data",u=>s+=u.toString()),o.on("error",r),o.on("close",()=>{clearTimeout(a),n(s)})})}function Ve(e){let t=e.indexOf(R),n=e.lastIndexOf(R);if(t===-1||n<=t)return{};let r={};for(let o of e.slice(t+R.length,n).split(`
`)){let s=o.indexOf("=");if(s<=0)continue;let a=o.slice(0,s);/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)&&(r[a]=o.slice(s+1))}return r}async function j(){return{...process.env,...await Ye()}}var E=require("node:fs"),H=require("node:os"),N=require("node:path");function Ke(e=(0,H.homedir)()){try{let n=JSON.parse((0,E.readFileSync)((0,N.join)(e,".claude.json"),"utf8")).cachedUsageUtilization?.utilization,r=[n?.five_hour,n?.seven_day].filter(Boolean),o=r.map(i=>i.utilization).filter(i=>typeof i=="number");if(o.length===0)return{adapter:"claude",known:!1,detail:"no utilization cache"};let s=Math.max(...o),a=ce(100-s),u=r.map(i=>i.resets_at).filter(i=>typeof i=="string").sort()[0];return{adapter:"claude",known:!0,usedPercent:s,headroom:a,...u?{resetsAt:u}:{},reachedLimit:s>=100,detail:`5h/weekly worst ${s}% used \u2192 ${a}% headroom`}}catch{return{adapter:"claude",known:!1,detail:"usage cache unreadable"}}}function Ge(e=(0,H.homedir)()){try{let t=Ze((0,N.join)(e,".codex","sessions"));if(!t)return{adapter:"codex",known:!1,detail:"no rollout sessions"};let n=Qe((0,E.readFileSync)(t,"utf8"));if(!n)return{adapter:"codex",known:!1,detail:"no rate_limits in rollout"};let r=[n.primary,n.secondary].filter(Boolean),o=r.map(i=>i.used_percent).filter(i=>typeof i=="number");if(o.length===0)return{adapter:"codex",known:!1,detail:"rate_limits had no percentages"};let s=Math.max(...o),a=ce(100-s),u=r.map(i=>i.resets_at).filter(i=>typeof i=="number").sort((i,c)=>i-c)[0];return{adapter:"codex",known:!0,usedPercent:s,headroom:a,...u?{resetsAt:new Date(u*1e3).toISOString()}:{},reachedLimit:!!n.rate_limit_reached_type||s>=100,detail:`worst window ${s}% used \u2192 ${a}% headroom`}}catch{return{adapter:"codex",known:!1,detail:"usage cache unreadable"}}}function le(e=(0,H.homedir)()){return{claude:Ke(e),codex:Ge(e)}}function Qe(e){let t;for(let r of e.split(`
`))if(r.includes('"rate_limits"'))try{let o=n(JSON.parse(r));o&&(t=o)}catch{}return t;function n(r){if(r&&typeof r=="object"){let o=r;if(o.rate_limits&&typeof o.rate_limits=="object")return o.rate_limits;for(let s of Object.values(o)){let a=n(s);if(a)return a}}}}function Ze(e){let t,n=r=>{let o;try{o=(0,E.readdirSync)(r,{withFileTypes:!0})}catch{return}for(let s of o){let a=(0,N.join)(r,s.name);if(s.isDirectory())n(a);else if(s.name.startsWith("rollout-")&&s.name.endsWith(".jsonl")){let u=(0,E.statSync)(a).mtimeMs;(!t||u>t.mtime)&&(t={path:a,mtime:u})}}};return n(e),t?.path}function ce(e){return Math.round(e*10)/10}var P=class{constructor(t){this.context=t;this.context.subscriptions.push(this.output)}static viewId="orchestratorMvp.view";view;plan;running;output=$.window.createOutputChannel("Orchestrator MVP");resolveWebviewView(t){this.view=t,t.webview.options={enableScripts:!0},t.webview.html=this.html(),t.webview.onDidReceiveMessage(n=>this.onMessage(n))}cfg(){let t=$.workspace.getConfiguration("orchestratorMvp"),n=t.get("mainModel","claude-opus-4-8"),r=b("claude",n)??b("claude","claude-opus-4-8"),o=Xe(t.get("mainEffort","high"))??"high";return{mainModel:r.id,mainEffort:w(r,o),claudeBin:t.get("claudePath","claude"),codexBin:t.get("codexPath","codex"),timeoutMs:t.get("timeoutSeconds",240)*1e3}}cwd(){return $.workspace.workspaceFolders?.[0]?.uri.fsPath??process.cwd()}post(t){this.view?.webview.postMessage(t)}async onMessage(t){t.type==="analyze"?await this.analyze(t.prompt??""):t.type==="run"?await this.run():t.type==="cancel"&&this.running?.abort()}sessionLog(t){this.output.appendLine(t),this.post({type:"stream",id:"session",mode:"log",text:t})}checkUsage(){let t=$.workspace.getConfiguration("orchestratorMvp").get("usageFloorPercent",20);this.sessionLog("\u25B8 Checking how much of your Claude and Codex usage is left\u2026");let n=le();return this.sessionLog(`   ${pe("Claude",n.claude,t)}`),this.sessionLog(`   ${pe("Codex",n.codex,t)}`),{...n,softFloor:t}}runSummary(t){let n=t.reduce((i,c)=>i+c.outputTokens,0),r=t.reduce((i,c)=>i+c.inputTokens,0),o=new Map;for(let i of t)o.set(`${i.adapter}/${i.model}`,(o.get(`${i.adapter}/${i.model}`)??0)+i.outputTokens);let s=[...o.entries()].map(([i,c])=>({model:i,out:c})),a=t.filter(i=>!i.ok).length;return{line:`${t.length} subtasks (${a} failed) \xB7 ${r} in / ${n} out tokens \xB7 models: ${s.map(i=>`${i.model} (${i.out})`).join(", ")}`,totalOut:n,byModel:s}}async analyze(t){let n=t.trim();if(!n)return;let r=this.cfg();this.plan=void 0,this.output.clear(),this.output.show(!0),this.post({type:"status",text:`Analysing with ${r.mainModel} (${r.mainEffort})...`});try{let o=await j(),s=this.checkUsage();this.sessionLog(`\u25B8 Analysing the request with ${L("claude",r.mainModel)} (${r.mainEffort} effort)\u2026`);let a={bin:r.claudeBin,model:r.mainModel,effort:r.mainEffort,env:o,cwd:this.cwd(),timeoutMs:r.timeoutMs},u=await oe(n,a,s,this.running?.signal,i=>this.forwardLive("analysis",i));this.sessionLog(`\u25B8 Plan ready: ${u.subtasks.length} subtask(s). Review and press Run plan.`),this.plan=u,this.post({type:"plan",plan:u,mainModel:r.mainModel,mainEffort:r.mainEffort})}catch(o){this.post({type:"error",text:o instanceof Error?o.message:String(o)})}}forwardLive(t,n){if(n.type==="delta"&&n.text)this.output.append(n.text),this.post({type:"stream",id:t,mode:"delta",text:n.text});else if(n.type==="log"&&n.text)this.output.appendLine(`[${t}] ${n.text}`),this.post({type:"stream",id:t,mode:"log",text:n.text});else if(n.type==="usage"){let r=`tokens in=${n.inputTokens} out=${n.outputTokens}`;this.output.appendLine(`[${t}] ${r}`),this.post({type:"stream",id:t,mode:"log",text:r})}}async run(){let t=this.plan;if(!t)return;if(!$.workspace.workspaceFolders?.length){this.post({type:"error",text:"Open a folder in VS Code first \u2014 the orchestrator writes generated files into the current workspace folder."});return}let n=this.cfg();this.running=new AbortController,this.output.show(!0),this.sessionLog(`
\u25B8 Running ${t.subtasks.length} subtask(s) in ${this.cwd()}`),this.post({type:"runStart"});try{let r=await j(),o={claudeBin:n.claudeBin,codexBin:n.codexBin,env:r,cwd:this.cwd(),timeoutMs:n.timeoutMs,signal:this.running.signal,onEvent:d=>{if(d.type==="start")this.sessionLog(`
\u25B8 ${d.subtask.title} \u2192 ${L(d.subtask.adapter,d.subtask.model)} (${d.subtask.effort} effort)`),this.post({type:"progress",id:d.subtask.id,state:"running",model:`${d.subtask.adapter}/${d.subtask.model}`,effort:d.subtask.effort});else if(d.type==="log"||d.type==="delta"||d.type==="usage")this.forwardLive(d.subtask.id,d);else{let p=d.result.ok?"\u2713":"\u2717";this.sessionLog(`${p} ${d.result.id} ${d.result.ok?"done":"failed"} \xB7 ${(d.result.durationMs/1e3).toFixed(0)}s \xB7 ${d.result.outputTokens.toLocaleString()} tokens \xB7 ${L(d.result.adapter,d.result.model)}`),this.post({type:"progress",id:d.result.id,state:d.result.ok?"done":"failed",model:`${d.result.adapter}/${d.result.model}`,effort:d.result.effort,error:d.result.error,seconds:(d.result.durationMs/1e3).toFixed(1),outTokens:d.result.outputTokens})}}},s=await de(t,o),a=[];this.sessionLog(`
\u25B8 Writing files\u2026`);for(let d of s){if(!d.ok)continue;let p=U(d.text),m=await D(this.cwd(),p,g=>this.sessionLog(`   ${g}`));a.push(...m.map(g=>({label:g.label,kind:"generated"})))}this.post({type:"status",text:`Reviewing with ${L("claude",n.mainModel)}\u2026`}),this.sessionLog(`
\u25B8 Integration review with ${L("claude",n.mainModel)} (${n.mainEffort} effort)\u2026`);let u={bin:n.claudeBin,model:n.mainModel,effort:n.mainEffort,env:r,cwd:this.cwd(),timeoutMs:n.timeoutMs},i=await se(t,s,u,this.running.signal,d=>this.forwardLive("review",d)),c=U(i);if(c.length>0){this.sessionLog(`
\u25B8 Applying ${c.length} consistency fix(es)\u2026`);let d=await D(this.cwd(),c,p=>this.sessionLog(`   ${p}`));a.push(...d.map(p=>({label:p.label,kind:"fix"})))}let l=await Y(this.cwd(),t,s,i),f=this.runSummary(s);this.sessionLog(`
\u2713 Done. ${a.length} file(s) written. ${f.line}`),this.sessionLog(`  logs: ${l}`),this.post({type:"result",report:i,subtasks:s,outputRoot:this.cwd(),logRoot:l,artifacts:a,summary:f})}catch(r){this.output.appendLine(`
[error] ${r instanceof Error?r.message:String(r)}`),this.post({type:"error",text:r instanceof Error?r.message:String(r)})}finally{this.running=void 0}}html(){let t=String(Math.random()).slice(2);return`<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${t}';`}" />
<style>${tt}</style></head>
<body>
  <h2>Orchestrator</h2>
  <p class="hint">Describe what you want built. Opus analyses it, splits it into subtasks, and assigns each to the most efficient model and effort.</p>
  <textarea id="prompt" rows="5" placeholder="e.g. Build a thread-safe in-memory job queue in Python with a CLI runner, concurrency tests, and a README."></textarea>
  <div class="row"><button id="analyze" class="primary">Analyse</button><span id="status" class="status"></span></div>
  <div id="plan"></div>
  <h3 id="livehdr" hidden>Live activity</h3>
  <div id="live"></div>
  <div id="results"></div>
<script nonce="${t}">${nt}</script>
</body></html>`}};function Xe(e){return e==="low"||e==="medium"||e==="high"||e==="xhigh"||e==="max"||e==="ultra"?e:void 0}function L(e,t){let n=b(e,t);return n?n.label:t.replace(/-\d{6,}$/,"").split(/[-/]/).map(r=>r&&r[0].toUpperCase()+r.slice(1)).join(" ")}function pe(e,t,n){if(!t.known||t.headroom===void 0)return`${e} \u2014 usage not reported by the CLI`;let r=t.resetsAt?` (resets ${et(t.resetsAt)})`:"";return t.reachedLimit?`${e} \u2014 out of quota${r}`:t.headroom<n?`${e} \u2014 running low, ${t.headroom}% left${r} \xB7 work will shift to the other model`:`${e} \u2014 ${t.headroom}% left`}function et(e){let t=new Date(e).getTime(),n=Math.round((t-Date.now())/6e4);return Number.isFinite(n)?n<=0?"shortly":n<60?`in ${n}m`:n<24*60?`in ${Math.floor(n/60)}h ${n%60}m`:`on ${new Date(e).toLocaleString(void 0,{month:"short",day:"numeric",hour:"numeric"})}`:new Date(e).toLocaleString()}var tt=`
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; font-size: 13px; }
  h2 { margin: 0 0 4px; }
  .hint { color: var(--vscode-descriptionForeground); margin: 0 0 8px; }
  textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #0000); border-radius: 4px; padding: 6px; font-family: inherit; resize: vertical; }
  .row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  .status { color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--vscode-panel-border, #8884); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  .diff { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .st-running { color: var(--vscode-charts-yellow, #cc0); }
  .st-done { color: var(--vscode-charts-green, #0a0); }
  .st-failed { color: var(--vscode-errorForeground, #f33); }
  .card { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; padding: 8px 10px; margin-top: 10px; }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; }
  h3 { margin: 12px 0 4px; }
  .err { color: var(--vscode-errorForeground); }
  details { margin-top: 4px; }
  #activity { margin-top: 10px; }
  .actcard { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; margin-top: 8px; overflow: hidden; }
  .acthead { padding: 4px 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
  .stream { margin: 0; max-height: 220px; overflow: auto; padding: 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); }
  ul.files { margin: 6px 0 0; padding-left: 18px; }
`,nt=`
const vscode = acquireVsCodeApi();
let plan = null;
const $ = (id) => document.getElementById(id);

$('analyze').addEventListener('click', () => {
  const prompt = $('prompt').value;
  if (!prompt.trim()) return;
  $('plan').innerHTML = ''; $('results').innerHTML = ''; $('live').innerHTML = '';
  $('livehdr').hidden = false;
  $('analyze').disabled = true;
  vscode.postMessage({ type: 'analyze', prompt });
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'status') { $('status').textContent = m.text; }
  else if (m.type === 'error') { $('status').textContent = ''; $('analyze').disabled = false; $('results').innerHTML = '<div class="card err">' + escapeHtml(m.text) + '</div>'; }
  else if (m.type === 'plan') { plan = m.plan; renderPlan(m.plan); $('analyze').disabled = false; $('status').textContent = ''; }
  else if (m.type === 'runStart') { const b = $('run'); if (b) { b.disabled = true; b.textContent = 'Running\u2026'; } }
  else if (m.type === 'progress') { updateRow(m); }
  else if (m.type === 'stream') { streamTo(m); }
  else if (m.type === 'result') { renderResult(m); }
});

const LABELS = { session: 'orchestrator', analysis: 'analysis \xB7 main model', review: 'integration review \xB7 main model' };

// Live output per stream id (session, analysis, each subtask, final) \u2014 like a
// mini terminal, one card each, appended in order.
function streamTo(m) {
  const host = $('live');
  if (!host) return;
  let card = document.getElementById('act-' + m.id);
  if (!card) {
    card = document.createElement('div');
    card.className = 'actcard';
    card.id = 'act-' + m.id; // without this, every event made a new empty card
    card.innerHTML = '<div class="acthead mono">' + escapeHtml(LABELS[m.id] || m.id) + '</div><pre id="out-' + m.id + '" class="stream"></pre>';
    host.appendChild(card);
  }
  const pre = document.getElementById('out-' + m.id);
  if (!pre) return;
  if (m.mode === 'log') { pre.textContent += (pre.textContent ? '\\n' : '') + m.text; }
  else { pre.textContent += m.text; }
  pre.scrollTop = pre.scrollHeight;
}

function renderPlan(plan) {
  let rows = plan.subtasks.map(s => {
    const deps = s.dependsOn.length ? ' <span class="diff">after ' + s.dependsOn.join(', ') + '</span>' : '';
    return '<tr data-id="' + s.id + '">' +
      '<td class="mono">' + escapeHtml(s.id) + '</td>' +
      '<td>' + escapeHtml(s.title) + deps + '<div class="diff">' + escapeHtml(s.routingNote) + '</div></td>' +
      '<td>' + escapeHtml(s.kind) + '<br><span class="diff">' + escapeHtml(s.difficulty) + '</span></td>' +
      '<td id="model-' + s.id + '"><span class="pill">' + escapeHtml(s.adapter) + '</span><br><span class="mono diff">' + escapeHtml(s.model) + '</span><br><span class="diff">' + escapeHtml(s.effort) + '</span></td>' +
      '<td class="status st" id="st-' + s.id + '">\u2014</td>' +
      '</tr>';
  }).join('');
  $('plan').innerHTML =
    '<table><thead><tr><th>id</th><th>subtask</th><th>kind</th><th>model</th><th>status</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="row"><button id="run" class="primary">Run plan</button><button id="cancel">Cancel</button>' +
    '<span class="diff">' + plan.subtasks.length + ' subtasks - analysed by main model</span></div>';
  $('run').addEventListener('click', () => vscode.postMessage({ type: 'run' }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
}

function updateRow(m) {
  const cell = $('st-' + m.id);
  if (!cell) return;
  if (m.state === 'running') { cell.className = 'status st-running'; cell.textContent = 'running\u2026'; }
  else if (m.state === 'done') { cell.className = 'status st-done'; cell.textContent = 'done ' + m.seconds + 's / ' + m.outTokens + ' out'; }
  else { cell.className = 'status st-failed'; cell.textContent = 'failed: ' + (m.error || 'failed'); }
  // Reflect the model actually used (may differ from the plan after a reroute).
  const mc = $('model-' + m.id);
  if (mc && m.model) {
    const [adapter, model] = m.model.split('/');
    mc.innerHTML = '<span class="pill">' + escapeHtml(adapter) + '</span><br><span class="mono diff">' + escapeHtml(model || '') + '</span><br><span class="diff">' + escapeHtml(m.effort || '') + '</span>';
  }
}

function renderResult(m) {
  let html = '';
  if (m.summary) {
    html += '<h3>Summary</h3><div class="card diff">' + escapeHtml(m.summary.line) + '</div>';
  }
  const files = (m.artifacts || []);
  const fileList = files.map(a => '<li class="mono">' + escapeHtml(a.label) + (a.kind === 'fix' ? ' <span class="diff">(fixed in review)</span>' : '') + '</li>').join('');
  html += '<h3>Files written to your workspace</h3><div class="card"><div class="mono diff">' + escapeHtml(m.outputRoot || '') + '</div><ul class="files">' + (fileList || '<li class="diff">no files were declared by the workers</li>') + '</ul>' +
    (m.logRoot ? '<div class="diff">logs &amp; raw transcripts: ' + escapeHtml(m.logRoot) + '</div>' : '') + '</div>';
  html += '<h3>Integration review</h3><div class="card"><pre>' + escapeHtml(m.report || '') + '</pre></div>';
  html += '<h3>Per-subtask transcripts</h3>';
  for (const r of m.subtasks) {
    html += '<details><summary>' + escapeHtml(r.id) + ' \u2014 ' + escapeHtml(r.adapter + '/' + r.model + ' / ' + r.effort) + (r.ok ? '' : ' (failed)') + '</summary>' +
      '<div class="card">' + (r.ok ? '<pre>' + escapeHtml(r.text) + '</pre>' : '<div class="err">' + escapeHtml(r.error || 'failed') + '</div>') + '</div></details>';
  }
  $('results').innerHTML = html;
  const b = $('run'); if (b) { b.disabled = false; b.textContent = 'Run again'; }
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
`;function rt(e){let t=new P(e);e.subscriptions.push(fe.window.registerWebviewViewProvider(P.viewId,t,{webviewOptions:{retainContextWhenHidden:!0}}))}function ot(){}0&&(module.exports={activate,deactivate});
