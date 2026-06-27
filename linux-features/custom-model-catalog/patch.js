"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MODEL_PICKER_VARIANTS = [
  {
    name: "current model query filter",
    needle: "let s=[],c=null,l=o&&e!==`amazonBedrock`,",
    replacement: "let s=[],c=null,l=!1,",
  },
  {
    name: "legacy model query filter",
    needle: "let a=[],o=null,s=i&&e!==`amazonBedrock`;",
    replacement: "let a=[],o=null,s=!1;",
  },
  {
    name: "model query filter",
    needle: "let u=c.useHiddenModels&&o!==`amazonBedrock`,d;",
    replacement: "let u=!1,d;",
  },
];

const MODEL_QUERY_SHIM_HELPER_NAME = "codexLinuxCustomModelMergeListModels";
const MODEL_QUERY_SHIM_HELPER_SOURCE = [
  "function codexLinuxCustomModelArray(e){return Array.isArray(e)?e:[]}",
  "function codexLinuxCustomModelObject(e){return e&&typeof e==`object`&&!Array.isArray(e)?e:null}",
  "function codexLinuxCustomModelString(e){return typeof e==`string`&&e.trim().length>0?e.trim():typeof e==`number`&&Number.isFinite(e)?String(e):null}",
  "function codexLinuxCustomModelPositiveInt(e){let t=typeof e==`number`?e:typeof e==`string`?Number(e.trim()):NaN;return Number.isFinite(t)&&t>0?Math.floor(t):null}",
  "function codexLinuxCustomModelCatalogRows(e){return Array.isArray(e)?e:codexLinuxCustomModelArray(codexLinuxCustomModelObject(e)?.models)}",
  "function codexLinuxCustomModelStringMap(e){let t=codexLinuxCustomModelObject(e),n={};if(!t)return null;for(let[r,i]of Object.entries(t)){let e=codexLinuxCustomModelString(r),t=codexLinuxCustomModelString(i);e&&t&&(n[e]=t)}return Object.keys(n).length>0?n:null}",
  "function codexLinuxCustomModelSafeStaticHeader(e){let t=String(e).trim().toLowerCase();return t.length>0&&!/^(authorization|proxy-authorization|cookie|set-cookie)$/u.test(t)&&!/(api[-_]?key|token|secret|credential|password|bearer)/u.test(t)}",
  "function codexLinuxCustomModelSafeHttpHeaders(e){let t=codexLinuxCustomModelObject(e),n={};if(!t)return null;for(let[r,i]of Object.entries(t)){let e=codexLinuxCustomModelString(r),t=codexLinuxCustomModelString(i);e&&t&&codexLinuxCustomModelSafeStaticHeader(e)&&(n[e]=t)}return Object.keys(n).length>0?n:null}",
  "function codexLinuxCustomModelAuthConfig(e){let t=codexLinuxCustomModelObject(e),n=codexLinuxCustomModelString(t?.command);return n?{command:n}:null}",
  "function codexLinuxCustomModelProviderConfigs(e){let t=codexLinuxCustomModelObject(e)?.providers,n=new Map;if(!codexLinuxCustomModelObject(t))return n;for(let[r,i]of Object.entries(t)){let a=codexLinuxCustomModelString(r),o=codexLinuxCustomModelObject(i);if(!a||!o)continue;let s={};for(let e of[`name`,`base_url`,`wire_api`,`env_key`]){let t=codexLinuxCustomModelString(o[e]);t&&(s[e]=t)}let c=codexLinuxCustomModelStringMap(o.env_http_headers);c&&(s.env_http_headers=c);let l=codexLinuxCustomModelSafeHttpHeaders(o.http_headers);l&&(s.http_headers=l);let u=codexLinuxCustomModelAuthConfig(o.auth);u&&(s.auth=u);typeof o.requires_openai_auth==`boolean`&&(s.requires_openai_auth=o.requires_openai_auth);for(let e of[`request_max_retries`,`stream_max_retries`,`stream_idle_timeout_ms`]){let t=codexLinuxCustomModelPositiveInt(o[e]);t!=null&&(s[e]=t)}Object.keys(s).length>0&&n.set(a,s)}return n}",
  "function codexLinuxCustomModelMergeProviderConfigs(e){let t=new Map;for(let n of codexLinuxCustomModelArray(e))for(let[r,i]of codexLinuxCustomModelProviderConfigs(n))t.has(r)||t.set(r,i);return t}",
  "function codexLinuxCustomModelReasoning(e){let t=codexLinuxCustomModelArray(e).map(e=>({reasoningEffort:codexLinuxCustomModelString(e.reasoningEffort??e.effort)??`medium`,description:codexLinuxCustomModelString(e.description)??``}));return t.length>0?t:[{reasoningEffort:`medium`,description:`Balanced speed and reasoning`}]}",
  "function codexLinuxCustomModelRuntimeConfig(e){let t={},n=codexLinuxCustomModelPositiveInt(e.contextWindow??e.context_window??e.maxContextWindow??e.max_context_window);n!=null&&(t.model_context_window=n);let r=codexLinuxCustomModelPositiveInt(e.autoCompactTokenLimit??e.auto_compact_token_limit);r!=null&&(t.model_auto_compact_token_limit=r);let i=e.truncationPolicy??e.truncation_policy;i&&typeof i==`object`&&!Array.isArray(i)&&(t.truncation_policy=i);return t}",
  "function codexLinuxCustomModelToRow(e,t){let n=codexLinuxCustomModelString(e.slug);if(!n)return null;let r=codexLinuxCustomModelArray(e.input_modalities??e.inputModalities);r.length||(r=[`text`]);let i=codexLinuxCustomModelString(e.model_provider??e.modelProvider);if(i==null)return null;let a=i,o=codexLinuxCustomModelString(e.provider_display_name??e.providerDisplayName??e.provider_name??e.providerName)??codexLinuxCustomModelString(t?.get(a)?.name)??codexLinuxCustomModelString(e.provider??e.owned_by??e.ownedBy)??a,s=codexLinuxCustomModelString(e.display_name??e.displayName??e.name??n)??n,c=codexLinuxCustomModelString(e.description)??`${s} via ${o}.`,l=codexLinuxCustomModelString(e.upstream_model_id??e.upstreamModelId??e.model??n)??n,u=codexLinuxCustomModelString(e.source)??(a===`codex_shim`?`CLIProxyAPI/local adapter`:`custom catalog`),d=codexLinuxCustomModelString(e.context_window??e.max_context_window??e.contextWindow??e.maxContextWindow),f=codexLinuxCustomModelString(e.model_catalog_json??e.modelCatalogJson),p=e.auto_compact_token_limit??e.autoCompactTokenLimit??null,m=e.truncation_policy??e.truncationPolicy??null;return{model:n,displayName:s,description:c,hidden:!1,isDefault:!1,modelProvider:a,model_provider:a,explicitModelProvider:i!=null,owned_by:codexLinuxCustomModelString(e.owned_by??e.ownedBy)??a,provider:a,providerDisplayName:o,upstreamModelId:l,source:u,contextWindow:d,modelCatalogJson:f,autoCompactTokenLimit:p,truncationPolicy:m,inputModalities:r,supportedReasoningEfforts:codexLinuxCustomModelReasoning(e.supported_reasoning_efforts??e.supportedReasoningEfforts??e.supported_reasoning_levels),defaultReasoningEffort:codexLinuxCustomModelString(e.default_reasoning_effort??e.defaultReasoningEffort??e.default_reasoning_level)??`medium`,supportsTools:e.supports_tools===!0||e.supportsTools===!0,supportsReasoning:e.supports_reasoning===!0||e.supportsReasoning===!0,supportsStreaming:e.supports_streaming!==!1&&e.supportsStreaming!==!1,supportsImageInputs:r.includes(`image`),supportsImageDetailOriginal:e.supports_image_detail_original===!0||e.supportsImageDetailOriginal===!0}}",
  "function codexLinuxCustomModelExistingRowMatches(e,t){if(!e||typeof e!=`object`)return!1;let n=codexLinuxCustomModelString(e.modelProvider??e.model_provider??e.provider),r=codexLinuxCustomModelString(t.modelProvider??t.model_provider);if(n&&r&&n===r)return!0;let i=codexLinuxCustomModelString(e.displayName??e.display_name??e.name),a=codexLinuxCustomModelString(t.displayName??t.display_name??t.name),o=codexLinuxCustomModelString(e.description),s=codexLinuxCustomModelString(t.description);return i!=null&&a!=null&&i===a&&o!=null&&s!=null&&o===s}",
  "async function codexLinuxCustomModelFetchCatalogs(){try{let e=await fetch(`/codex-linux/custom-model-catalog.json`,{cache:`no-store`});return e.ok?[await e.json()]:[]}catch{return[]}}",
  "async function codexLinuxCustomModelMergeListModels(e){try{let t=await codexLinuxCustomModelFetchCatalogs(),n=codexLinuxCustomModelMergeProviderConfigs(t),r=t.flatMap(e=>codexLinuxCustomModelCatalogRows(e)).map(e=>codexLinuxCustomModelToRow(e,n)).filter(Boolean),i=e&&typeof e==`object`?e:{data:[]},a=codexLinuxCustomModelArray(i.data),o=e=>typeof e==`string`?e.trim().toLowerCase():``,s=new Set(a.flatMap(e=>[o(e?.model),o(e?.id)]).filter(Boolean)),c=new Map,l=new Map(a.flatMap(e=>{let t=o(e?.model??e?.id);return t?[[t,e]]:[]})),u=new Set;for(let e of r){let t=o(e.model),n=`${e.providerDisplayName}\\0${e.displayName}`;if(!t||u.has(n))continue;u.add(n);let r=l.get(t);if(s.has(t)&&!codexLinuxCustomModelExistingRowMatches(r,e))continue;c.has(t)||c.set(t,e)}let d=new Set,f=[...c.values()].filter(e=>{let t=`${e.providerDisplayName}\\0${e.displayName}`;return!s.has(o(e.model))&&!d.has(t)&&(d.add(t),!0)}),p=[...c.values()],m=e=>{let t=o(e.model),n=o(e.upstreamModelId);return n&&n!==t&&!s.has(n)?[t,n]:[t]};globalThis.__codexLinuxCustomModelSlugs=new Set(p.flatMap(m)),globalThis.__codexLinuxCustomModelCatalogPaths=new Map(p.flatMap(e=>e.modelCatalogJson==null?[]:m(e).map(t=>[t,e.modelCatalogJson]))),globalThis.__codexLinuxCustomModelRuntimeConfig=new Map(p.flatMap(e=>{let t=codexLinuxCustomModelRuntimeConfig(e);return Object.keys(t).length===0?[]:m(e).map(n=>[n,t])})),globalThis.__codexLinuxCustomModelProviders=new Map(p.flatMap(e=>m(e).map(t=>[t,e.modelProvider]))),globalThis.__codexLinuxCustomModelWireModels=new Map(p.flatMap(e=>{let t=codexLinuxCustomModelString(e.upstreamModelId);return t?m(e).map(e=>[e,t]):[]})),globalThis.__codexLinuxCustomModelToolSupport=new Map(p.flatMap(e=>m(e).map(t=>[t,e.supportsTools===!0]))),globalThis.__codexLinuxCustomModelProviderConfigs=new Map([...n].filter(([e])=>p.some(t=>t.modelProvider===e)));return{...i,data:[...a,...f]}}catch{return e}}",
].join("");
const MODEL_QUERY_SHIM_INSERTION = "var x=100,S=[`models`,`list`];";
const MODEL_QUERY_SHIM_INSERTION_REGEX =
  /var [A-Za-z_$][\w$]*=100,[A-Za-z_$][\w$]*=\[`models`,`list`\];/u;
const MODEL_QUERY_SHIM_CURRENT_INSERTION_REGEX =
  /function [A-Za-z_$][\w$]*\(\{authMethod:[A-Za-z_$][\w$]*,availableModels:[A-Za-z_$][\w$]*,defaultModel:[A-Za-z_$][\w$]*,/u;
const MODEL_QUERY_SHIM_NEEDLE =
  "queryFn:()=>i(`list-models-for-host`,{hostId:a,includeHidden:!0,cursor:null,limit:s}),select:";
const MODEL_QUERY_SHIM_PATCH =
  "queryFn:async()=>codexLinuxCustomModelMergeListModels(await i(`list-models-for-host`,{hostId:a,includeHidden:!0,cursor:null,limit:s})),select:";
const MODEL_QUERY_SHIM_REGEX =
  /queryFn:\(\)=>([A-Za-z_$][\w$]*)\(`list-models-for-host`,\{hostId:([A-Za-z_$][\w$]*),includeHidden:!0,cursor:null,limit:([A-Za-z_$][\w$]*)\}\),select:/u;
const MODEL_QUERY_SHIM_PATCHED_REGEX =
  /queryFn:async\(\)=>codexLinuxCustomModelMergeListModels\(await [A-Za-z_$][\w$]*\(`list-models-for-host`,\{hostId:[A-Za-z_$][\w$]*,includeHidden:!0,cursor:null,limit:[A-Za-z_$][\w$]*\}\)\),select:/u;

const RECENT_THREADS_REGEX =
  /listRecentThreads\(\{cursor:([A-Za-z_$][\w$]*),limit:([A-Za-z_$][\w$]*)\}\)\{return this\.params\.requestClient\.sendRequest\(`thread\/list`,\{limit:\2,cursor:\1,sortKey:this\.recentConversationSortKey,modelProviders:null,archived:!1,sourceKinds:([A-Za-z_$][\w$]*)\}\)\}/u;
const RECENT_THREADS_PATCHED_REGEX =
  /listRecentThreads\(\{cursor:([A-Za-z_$][\w$]*),limit:([A-Za-z_$][\w$]*)\}\)\{return this\.params\.requestClient\.sendRequest\(`thread\/list`,\{limit:\2,cursor:\1,sortKey:this\.recentConversationSortKey,modelProviders:\[\],archived:!1,sourceKinds:([A-Za-z_$][\w$]*)\}\)\}/u;
const RECENT_THREADS_PROVIDER_REGEX =
  /(listRecentThreads\(\{[^}]*\}\)\{return this\.params\.requestClient\.sendRequest\(`thread\/list`,\{[^}]*?modelProviders:)null(,archived:!1,sourceKinds:[^}]+\}\)\})/u;
const RECENT_THREADS_PROVIDER_PATCHED_REGEX =
  /listRecentThreads\(\{[^}]*\}\)\{return this\.params\.requestClient\.sendRequest\(`thread\/list`,\{[^}]*?modelProviders:\[\],archived:!1,sourceKinds:[^}]+\}\)\}/u;
const RECENT_THREADS_PARAMS_PROVIDER_REGEX =
  /(listRecentThreads\(\{[^}]*\}\)\{let [A-Za-z_$][\w$]*=\{[^}]*?modelProviders:)null(,archived:!1,sourceKinds:[^}]+\};return this\.params\.requestClient\.sendRequest\(`thread\/list`,[A-Za-z_$][\w$]*\)\})/u;
const RECENT_THREADS_PARAMS_PROVIDER_PATCHED_REGEX =
  /listRecentThreads\(\{[^}]*\}\)\{let [A-Za-z_$][\w$]*=\{[^}]*?modelProviders:\[\],archived:!1,sourceKinds:[^}]+\};return this\.params\.requestClient\.sendRequest\(`thread\/list`,[A-Za-z_$][\w$]*\)\}/u;
const ROUTING_HELPER_NAME = "codexLinuxCustomModelApplyRouting";
const ROUTING_HELPER_SOURCE = [
  "function codexLinuxCustomModelSlugKey(e){return typeof e==`string`?e.trim().toLowerCase():``}",
  "function codexLinuxCustomModelCustomSlug(e){let t=codexLinuxCustomModelSlugKey(e);return t.length>0&&globalThis.__codexLinuxCustomModelSlugs?.has(t)===!0}",
  "function codexLinuxCustomModelSupportsTools(e){let t=codexLinuxCustomModelSlugKey(e);return t.length>0&&globalThis.__codexLinuxCustomModelToolSupport?.get(t)===!0}",
  "function codexLinuxCustomModelRouteModel(e,t){return codexLinuxCustomModelSlugKey(e).length>0?e:t}",
  "function codexLinuxCustomModelProviderForSlug(e){let t=codexLinuxCustomModelSlugKey(e);if(!t)return null;let n=globalThis.__codexLinuxCustomModelProviders?.get(t);return typeof n==`string`&&n.trim().length>0?n.trim():null}",
  "function codexLinuxCustomModelWireModel(e){let t=codexLinuxCustomModelSlugKey(e),n=globalThis.__codexLinuxCustomModelWireModels?.get(t);return typeof n==`string`&&n.trim().length>0?n.trim():e}",
  "function codexLinuxCustomModelShimProviderConfig(){return{name:`Codex Shim`,base_url:`http://127.0.0.1:8765/v1`,wire_api:`responses`,experimental_bearer_token:`dummy`,request_max_retries:3,stream_max_retries:3,stream_idle_timeout_ms:600000}}",
  "function codexLinuxCustomModelProviderConfig(e){let t=globalThis.__codexLinuxCustomModelProviderConfigs?.get(e),n=t&&typeof t==`object`&&!Array.isArray(t)?t:null;return e===`codex_shim`?{...codexLinuxCustomModelShimProviderConfig(),...n}:n}",
  "function codexLinuxCustomModelApplyRouting(e,t){if(!codexLinuxCustomModelCustomSlug(t))return e;let n=codexLinuxCustomModelSlugKey(t),r=codexLinuxCustomModelProviderForSlug(t);if(r==null)return e;let i=codexLinuxCustomModelWireModel(t),a=globalThis.__codexLinuxCustomModelCatalogPaths?.get(n),o=globalThis.__codexLinuxCustomModelRuntimeConfig?.get(n)??{},s={...e.config,model:i,model_provider:r,...o,...(a==null?{}:{model_catalog_json:a})},c=codexLinuxCustomModelProviderConfig(r);c&&(s[`model_providers.${r}`]={...c,...e.config?.[`model_providers.${r}`]});let l=e?.collaborationMode==null?e?.collaborationMode:{...e.collaborationMode,settings:{...e.collaborationMode.settings,model:i}};return{...e,model:i,modelProvider:r,config:s,collaborationMode:l}}",
  "function codexLinuxCustomModelApplyThreadSettings(e){let t=e?.model??e?.collaborationMode?.settings?.model;if(!codexLinuxCustomModelCustomSlug(t))return e;let n=codexLinuxCustomModelApplyRouting({config:e?.config??{}},t);return{...e,model:n.model,modelProvider:n.modelProvider,config:n.config,collaborationMode:e?.collaborationMode==null?e?.collaborationMode:{...e.collaborationMode,settings:{...e.collaborationMode.settings,model:n.model}}}}",
  "function codexLinuxCustomModelNeedsProviderResume(e,t){let n=t?.model??t?.collaborationMode?.settings?.model;if(typeof n!=`string`||n.trim().length===0)return!1;let r=e?.modelProvider??e?.model_provider??codexLinuxCustomModelProviderForSlug(e?.latestModel??e?.latestCollaborationMode?.settings?.model),i=codexLinuxCustomModelProviderForSlug(n);return(r??null)!==(i??null)}",
].join("");
const ROUTING_INSERTION_VARIANTS = ["var kg=5e3,Ag=class{", "var Qg=5e3,$g=class{", "WR=5e3,GR=class{"];
const ROUTING_INSERTION_REGEX =
  /var [A-Za-z_$][\w$]*=5e3,[A-Za-z_$][\w$]*=class\{dynamicToolsForThreadStartRequests=/u;
const ROUTING_NEEDLE_VARIANTS = [
  "let c=await en(e,await VI(t,()=>this.params.requestClient.sendRequest(`configRequirements/read`,void 0,{timeoutMs:M_})),()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{baseInstructions:s?.baseInstructions,threadSource:s?.threadSource});if(c=ct(c,a),",
  "let c=await C(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{persistExtendedHistory:s?.persistExtendedHistory??!1,threadSource:s?.threadSource});if(c=ae(c,a),",
  "let c=await C(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{threadSource:s?.threadSource});if(c=O(c,a),",
  "let c=await et(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{baseInstructions:s?.baseInstructions,threadSource:s?.threadSource});if(c=yt(c,a),",
];
const ROUTING_PATCH_VARIANTS = [
  "let c=await en(e,await VI(t,()=>this.params.requestClient.sendRequest(`configRequirements/read`,void 0,{timeoutMs:M_})),()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{baseInstructions:s?.baseInstructions,threadSource:s?.threadSource});if(c=codexLinuxCustomModelApplyRouting(c,e),c=ct(c,a),",
  "let c=await C(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{persistExtendedHistory:s?.persistExtendedHistory??!1,threadSource:s?.threadSource});if(c=codexLinuxCustomModelApplyRouting(c,e),c=ae(c,a),",
  "let c=await C(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{threadSource:s?.threadSource});if(c=codexLinuxCustomModelApplyRouting(c,e),c=O(c,a),",
  "let c=await et(e,t,()=>this.params.fetchFromHost(`get-copilot-api-proxy-info`),n,r,()=>this.buildThreadCodexConfig(n),o,i,{baseInstructions:s?.baseInstructions,threadSource:s?.threadSource});if(c=codexLinuxCustomModelApplyRouting(c,e),c=yt(c,a),",
];
const ROUTING_INSERTION = ROUTING_INSERTION_VARIANTS[0];
const ROUTING_NEEDLE = ROUTING_NEEDLE_VARIANTS[0];
const ROUTING_PATCH = ROUTING_PATCH_VARIANTS[0];
const ROUTING_NEEDLE_REGEX =
  /let ([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\(e,t,\(\)=>this\.params\.fetchFromHost\(`get-copilot-api-proxy-info`\),n,r,\(\)=>this\.buildThreadCodexConfig\(n\),o,i,(\{(?:persistExtendedHistory:s\?\.persistExtendedHistory\?\?!1,)?threadSource:s\?\.threadSource\})\);if\(\1=([A-Za-z_$][\w$]*)\(\1,a\),/u;
const CREATE_CONVERSATION_ROUTING_REGEX =
  /(threadCreation\.createConversation\(\{[\s\S]{0,1600}?collaborationMode:([A-Za-z_$][\w$]*)[\s\S]{0,1600}?config:)([A-Za-z_$][\w$]*)(,projectAssignment:)/u;
const CREATE_CONVERSATION_ROUTING_PATCHED_REGEX =
  /threadCreation\.createConversation\(\{[\s\S]{0,1600}?config:codexLinuxCustomModelApplyRouting\(\{config:[A-Za-z_$][\w$]*\?\?\{\}\},[A-Za-z_$][\w$]*\?\.settings\?\.model\)\.config,projectAssignment:/u;
const FORK_ROUTING_REGEX =
  /let ([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\.buildThreadCodexConfig\(([A-Za-z_$][\w$]*)\?\?([A-Za-z_$][\w$]*)\?\.cwd\?\?null\),([A-Za-z_$][\w$]*)=await \2\.sendRequest\(`thread\/fork`,\{threadId:([A-Za-z_$][\w$]*),path:([A-Za-z_$][\w$]*)\?\?null,cwd:\3,threadSource:`user`,\.\.\.\1==null\?\{\}:\{config:\1\},/u;
const FORK_ROUTING_CURRENT_REGEX =
  /let ([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\.buildThreadCodexConfig\(([A-Za-z_$][\w$]*)\?\?([A-Za-z_$][\w$]*)\?\.cwd\?\?null\),([A-Za-z_$][\w$]*)=await \2\.sendRequest\(`thread\/fork`,\{threadId:([A-Za-z_$][\w$]*),path:([A-Za-z_$][\w$]*)\?\?null,cwd:\3,threadSource:([A-Za-z_$][\w$]*),\.\.\.\1==null\?\{\}:\{config:\1\},/u;
const FORK_ROUTING_INLINE_CONFIG_REGEX =
  /let ([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\.buildThreadCodexConfig\(([A-Za-z_$][\w$]*)\?\?([A-Za-z_$][\w$]*)\?\.cwd\?\?null\),([A-Za-z_$][\w$]*)=await \2\.sendRequest\(`thread\/fork`,\{threadId:([A-Za-z_$][\w$]*),path:([A-Za-z_$][\w$]*)\?\?null,cwd:\3,threadSource:([A-Za-z_$][\w$]*),config:\1\?\?void 0,/u;
const FORK_ROUTING_MARKER =
  "codexLinuxCustomModelApplyRouting({config:await";
const THREAD_SETTINGS_UPDATE_REGEX =
  /async updateThreadSettingsForNextTurn\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=this\.pendingThreadSettingsUpdates\.get\(\1\),/u;
const THREAD_SETTINGS_UPDATE_PATCHED_REGEX =
  /async updateThreadSettingsForNextTurn\([A-Za-z_$][\w$]*,([A-Za-z_$][\w$]*)\)\{\1=codexLinuxCustomModelApplyThreadSettings\(\1\);let [A-Za-z_$][\w$]*=this\.pendingThreadSettingsUpdates\.get\([A-Za-z_$][\w$]*\),/u;
const THREAD_SETTINGS_PROVIDER_RESUME_MARKER =
  "codexLinuxCustomModelNeedsProviderResume(this.getConversation(";
const THREAD_SETTINGS_PROVIDER_RESUME_NEEDLE =
  "if(this.threadSettingsUpdateSupport!==`unsupported`)try";
const TURN_START_ROUTING_REGEX =
  /([A-Za-z_$][\w$]*)=\{threadId:[A-Za-z_$][\w$]*,clientUserMessageId:[\s\S]{0,1200}?model:([A-Za-z_$][\w$]*)[\s\S]{0,1200}?collaborationMode:([A-Za-z_$][\w$]*)\?\?null[\s\S]{0,1200}?attachments:[A-Za-z_$][\w$]*\.attachments\?\?\[\]\},([A-Za-z_$][\w$]*)=\{threadId:/u;
const TURN_START_ROUTING_PATCHED_REGEX =
  /[A-Za-z_$][\w$]*=codexLinuxCustomModelApplyRouting\(\{threadId:[A-Za-z_$][\w$]*,clientUserMessageId:[\s\S]{0,1200}?model:([A-Za-z_$][\w$]*)[\s\S]{0,1200}?collaborationMode:([A-Za-z_$][\w$]*)\?\?null[\s\S]{0,1200}?attachments:[A-Za-z_$][\w$]*\.attachments\?\?\[\]\},codexLinuxCustomModelRouteModel\(\1,\2\?\.settings\?\.model\)\),[A-Za-z_$][\w$]*=\{threadId:/u;
const TURN_START_ROUTING_UNSAFE_FALLBACK_PATCHED_REGEX =
  /([A-Za-z_$][\w$]*)=codexLinuxCustomModelApplyRouting\(\{threadId:[A-Za-z_$][\w$]*,clientUserMessageId:[\s\S]{0,1200}?model:([A-Za-z_$][\w$]*)[\s\S]{0,1200}?collaborationMode:([A-Za-z_$][\w$]*)\?\?null[\s\S]{0,1200}?attachments:[A-Za-z_$][\w$]*\.attachments\?\?\[\]\},\2\?\?\3\?\.settings\?\.model\),([A-Za-z_$][\w$]*)=\{threadId:/u;
const TURN_START_ROUTING_LEGACY_PATCHED_REGEX =
  /([A-Za-z_$][\w$]*)=codexLinuxCustomModelApplyRouting\(\{threadId:[A-Za-z_$][\w$]*,clientUserMessageId:[\s\S]{0,1200}?model:([A-Za-z_$][\w$]*)[\s\S]{0,1200}?collaborationMode:([A-Za-z_$][\w$]*)\?\?null[\s\S]{0,1200}?attachments:[A-Za-z_$][\w$]*\.attachments\?\?\[\]\},\2\),([A-Za-z_$][\w$]*)=\{threadId:/u;
const RESUME_SKIP_DYNAMIC_TOOLS_REGEX =
  /buildNewConversationParams\((\w+),(\w+),(\w+)\[0\]\?\?`\/`,(\w+),(\w+)\.approvalsReviewer,\{skipDynamicTools:!0,threadId:(\w+)\}\)/u;
const RESUME_SKIP_DYNAMIC_TOOLS_REPLACEMENT =
  "buildNewConversationParams($1,$2,$3[0]??`/`,$4,$5.approvalsReviewer,{skipDynamicTools:!codexLinuxCustomModelSupportsTools($1),threadId:$6})";
const RESUME_DYNAMIC_TOOLS_PAYLOAD_NEEDLE =
  "personality:p?.personality===void 0?f?.personality??A.personality:p.personality,excludeTurns:b,...b?{initialTurnsPage:{limit:5,itemsView:`full`}}:{}})";
const RESUME_DYNAMIC_TOOLS_PAYLOAD_PATCH =
  "personality:p?.personality===void 0?f?.personality??A.personality:p.personality,excludeTurns:b,...!codexLinuxCustomModelSupportsTools(A.model??A.collaborationMode?.settings?.model)||A.dynamicTools==null?{}:{dynamicTools:A.dynamicTools},...b?{initialTurnsPage:{limit:5,itemsView:`full`}}:{}})";
const MODEL_TOOLTIP_HELPER_NAME = "codexLinuxCustomModelTooltip";
const MODEL_TOOLTIP_HELPER_SOURCE = [
  "function codexLinuxCustomModelTooltipValue(e){return typeof e==`string`&&e.trim().length>0?e.trim():typeof e==`number`&&Number.isFinite(e)?String(e):null}",
  "function codexLinuxCustomModelTooltipList(e){return Array.isArray(e)?Array.from(new Set(e.flatMap(e=>typeof e==`string`&&e.trim().length>0?[e.trim()]:[]))).join(`, `)||null:null}",
  "function codexLinuxCustomModelOfficialProvider(e){return e==null||[`openai`,`chatgpt`,`copilot`,`amazonBedrock`].includes(e)}",
  "function codexLinuxCustomModelTooltip(e,t){let n=[],r=codexLinuxCustomModelTooltipValue(t);r&&n.push(r);let i=codexLinuxCustomModelTooltipValue(e.modelProvider??e.model_provider??e.provider??e.owner??e.owned_by??e.ownedBy??e.sourceProvider??e.source_provider),a=codexLinuxCustomModelTooltipValue(e.displayName??e.display_name??e.name),o=codexLinuxCustomModelTooltipValue(e.upstreamModelId??e.upstream_model_id??e.upstream_model??e.baseModel??e.base_model??e.model),s=codexLinuxCustomModelTooltipValue(e.source??e.catalogSource??e.catalog_source??e.sourceName??e.source_name);!s&&i&&!codexLinuxCustomModelOfficialProvider(i)&&(s=`CLIProxyAPI/local adapter`);let c=codexLinuxCustomModelTooltipValue(e.contextSize??e.context_size??e.contextWindow??e.context_window??e.maxContextTokens??e.max_context_tokens??e.contextLength??e.context_length),l=codexLinuxCustomModelTooltipValue(e.autoCompactTokenLimit??e.auto_compact_token_limit),u=codexLinuxCustomModelTooltipValue(e.truncationPolicy?.limit??e.truncation_policy?.limit),d=new Set,f=codexLinuxCustomModelTooltipList(e.capabilities??e.capabilityFlags??e.capability_flags);f&&f.split(`, `).forEach(e=>d.add(e));codexLinuxCustomModelTooltipList(e.inputModalities??e.input_modalities)?.split(`, `).forEach(e=>d.add(`${e} input`));codexLinuxCustomModelTooltipList(e.outputModalities??e.output_modalities??e.supportedOutputModalities??e.supported_output_modalities)?.split(`, `).forEach(e=>d.add(`${e} output`));e.supportsTools===!0&&d.add(`tools`);e.supports_images===!0&&d.add(`image input`);e.supportsImageInputs===!0&&d.add(`image input`);e.supportsFunctionCalling===!0&&d.add(`function calling`);e.supportsReasoning===!0&&d.add(`reasoning`);let p=codexLinuxCustomModelTooltipList((e.supportedReasoningEfforts??[]).map(e=>e.reasoningEffort));i&&n.push(`Provider: ${i}`);a&&n.push(`Display: ${a}`);o&&n.push(`Model: ${o}`);d.size>0&&n.push(`Capabilities: ${Array.from(d).join(`, `)}`);p&&n.push(`Reasoning: ${p}`);c&&n.push(`Context: ${c}`);l&&n.push(`Auto-compact: ${l}`);u&&n.push(`Truncation: ${u}`);s&&n.push(`Source: ${s}`);return n.length>0?n.join(`\\n`):void 0}",
].join("");
const MODEL_TOOLTIP_NEEDLE =
  "t[0]!==m||t[1]!==d?(y=Oi(d)?m.replace(/\\.$/u,``):void 0,t[0]=m,t[1]=d,t[2]=y):y=t[2];";
const MODEL_TOOLTIP_PATCH =
  "y=codexLinuxCustomModelTooltip(r,Oi(d)?m.replace(/\\.$/u,``):void 0);";
const MODEL_TOOLTIP_MEMO_REGEX =
  /t\[0\]!==([A-Za-z_$][\w$]*)\|\|t\[1\]!==([A-Za-z_$][\w$]*)\?\(([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\)\?\1\.replace\(\/\\\.\$\/u,``\):void 0,t\[0\]=\1,t\[1\]=\2,t\[2\]=\3\):\3=t\[2\];/u;
const MODEL_TOOLTIP_FUNCTION_REGEX =
  /(function [A-Za-z_$][\w$]*\(e\)\{let [A-Za-z_$][\w$]*=\(0,[A-Za-z_$][\w$]*\.c\)\(\d+\),\{[^}]*?modelOption:([A-Za-z_$][\w$]*)[^}]*\}=e)/u;
const MODEL_PROVIDER_GROUP_HELPER_NAME = "codexLinuxCustomModelGroupModelOptions";
const MODEL_PROVIDER_GROUP_HELPER_SOURCE = [
  "function codexLinuxCustomModelProviderGroupValue(e){return typeof e==`string`&&e.trim().length>0?e.trim():null}",
  "function codexLinuxCustomModelProviderGroupFromDescription(e){let t=codexLinuxCustomModelProviderGroupValue(e.description),n=codexLinuxCustomModelProviderGroupValue(e.displayName??e.display_name??e.name);if(!t||!n)return null;let r=`${n} via `;return t.startsWith(r)?codexLinuxCustomModelProviderGroupValue(t.slice(r.length).replace(/\\.$/u,``)):null}",
  "function codexLinuxCustomModelProviderGroupTitle(e){let t=codexLinuxCustomModelProviderGroupValue(e.providerDisplayName??e.provider_display_name)??codexLinuxCustomModelProviderGroupFromDescription(e);if(t)return t;let n=codexLinuxCustomModelProviderGroupValue(e.modelProvider??e.model_provider??e.provider??e.owned_by??e.ownedBy);if(!n)return`OpenAI`;let r=n.toLowerCase();return[`openai`,`chatgpt`,`copilot`].includes(r)?`OpenAI`:r===`amazonbedrock`?`Amazon Bedrock`:r===`codex_shim`?`Custom providers`:n.split(/[-_\\s]+/u).filter(Boolean).map(e=>e.charAt(0).toUpperCase()+e.slice(1)).join(` `)}",
  "function codexLinuxCustomModelGroupModelOptions(e,t,n,r){if(!Array.isArray(e))return e?.map?.(t);let i=new Map;for(let a of e){let o=codexLinuxCustomModelProviderGroupTitle(a);i.has(o)||i.set(o,[]),i.get(o).push(a)}if(i.size<=1)return e.map(t);let a=[],o=0;for(let[s,c]of i){a.length>0&&a.push((0,n.jsx)(r.Separator,{},`provider-separator-${o}`)),a.push((0,n.jsx)(r.Title,{children:s},`provider-title-${o}-${s}`));for(let e of c)a.push(t(e));o++}return a}",
].join("");
const MODEL_PROVIDER_GROUP_INSERTION_REGEX =
  /function [A-Za-z_$][\w$]*\(e\)\{let [A-Za-z_$][\w$]*=\(0,[A-Za-z_$][\w$]*\.c\)\(\d+\),\{align:/u;
const MODEL_PROVIDER_GROUP_NEEDLE =
  "Y=c?.map(e=>(0,T.jsx)(ee,{modelOption:e,selectedModel:s,selectedReasoningEffort:E,selectedServiceTier:k,selectedServiceTierIconKind:A,onSelect:(e,t)=>{_(e,t),h?.()}},e.model)),";
const MODEL_PROVIDER_GROUP_PATCH =
  "Y=codexLinuxCustomModelGroupModelOptions(c,e=>(0,T.jsx)(ee,{modelOption:e,selectedModel:s,selectedReasoningEffort:E,selectedServiceTier:k,selectedServiceTierIconKind:A,onSelect:(e,t)=>{_(e,t),h?.()}},e.model),T,p),";
const MODEL_PROVIDER_GROUP_CURRENT_NEEDLE =
  "fe=a?.map(e=>(0,DY.jsx)(Hut,{modelOption:e,selectedModel:i,selectedReasoningEffort:h,selectedServiceTier:E,selectedServiceTierIconKind:D,onSelect:(e,t)=>{d(e,t),M||u?.()}},e.model)),";
const MODEL_PROVIDER_GROUP_CURRENT_PATCH =
  "fe=codexLinuxCustomModelGroupModelOptions(a,e=>(0,DY.jsx)(Hut,{modelOption:e,selectedModel:i,selectedReasoningEffort:h,selectedServiceTier:E,selectedServiceTierIconKind:D,onSelect:(e,t)=>{d(e,t),M||u?.()}},e.model),DY,Zf),";
const COMPOSER_ATTACHMENT_PROP_NEEDLE =
  "onOpenGoalEditor:_c,supportsFileAttachments:ui!==`cloud`||!bi&&Ti===`local`,supportsRemoteFileAttachments:ui!==`cloud`&&Ti!==`local`});";
const COMPOSER_ATTACHMENT_PROP_PATCH =
  "onOpenGoalEditor:_c,supportsImageInputs:Jt,supportsFileAttachments:ui!==`cloud`||!bi&&Ti===`local`,supportsRemoteFileAttachments:ui!==`cloud`&&Ti!==`local`});";
const COMPOSER_IMAGE_CAPABILITY_REGEX =
  /supportsImageInputs:([A-Za-z_$][\w$]*)\}=mp\(/u;
const COMPOSER_IMAGE_HOOK_RESULT_REGEX =
  /\{imageInputUnsupportedReason:[A-Za-z_$][\w$]*,notifyImageInputUnsupported:[A-Za-z_$][\w$]*,supportsImageInputs:([A-Za-z_$][\w$]*)\}=[A-Za-z_$][\w$]*\(/u;
const COMPOSER_ATTACHMENT_PROP_REGEX =
  /onOpenGoalEditor:([A-Za-z_$][\w$]*),supportsFileAttachments:/u;
const ATTACHMENT_MENU_DESTRUCTURE_NEEDLE =
  "supportsFileAttachments:T,supportsRemoteFileAttachments:E,disabled:O}=e,k=T===void 0?!0:T,A=E===void 0?!1:E,j=O===void 0?!1:O,M=f(y),";
const ATTACHMENT_MENU_DESTRUCTURE_PATCH =
  "supportsFileAttachments:T,supportsRemoteFileAttachments:E,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,disabled:O}=e,k=T===void 0?!0:T,A=E===void 0?!1:E,j=O===void 0?!1:O,codexLinuxCustomModelCanAddImages=codexLinuxCustomModelSupportsImageInputs!==!1,M=f(y),";
const ATTACHMENT_MENU_PICKER_HANDLER_CACHE_NEEDLE =
  "if(t[16]!==ge||t[17]!==j||t[18]!==g||t[19]!==c||t[20]!==N||t[21]!==n||t[22]!==u||t[23]!==L||t[24]!==M||t[25]!==H||t[26]!==l||t[27]!==G||t[28]!==k){Ce=async function(){";
const ATTACHMENT_MENU_PICKER_HANDLER_CACHE_PATCH =
  "if(true||t[16]!==ge||t[17]!==j||t[18]!==g||t[19]!==c||t[20]!==N||t[21]!==n||t[22]!==u||t[23]!==L||t[24]!==M||t[25]!==H||t[26]!==l||t[27]!==G||t[28]!==k){Ce=async function(){";
const ATTACHMENT_MENU_PICKER_NEEDLE = "let{images:i,others:a}=bt(t),o=[];";
const ATTACHMENT_MENU_PICKER_PATCH =
  "let{images:i,others:a}=codexLinuxCustomModelCanAddImages?bt(t):{images:[],others:t},o=[];";
const ATTACHMENT_MENU_DROPDOWN_PROP_CACHE_NEEDLE = "let Fe;t[59]!==d||";
const ATTACHMENT_MENU_DROPDOWN_PROP_CACHE_PATCH = "let Fe;true||t[59]!==d||";
const ATTACHMENT_MENU_DROPDOWN_PROP_NEEDLE = "supportsFileAttachments:k,togglingSwitchRef:te})";
const ATTACHMENT_MENU_DROPDOWN_PROP_PATCH =
  "supportsFileAttachments:k,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,togglingSwitchRef:te})";
const ATTACHMENT_MENU_DROPDOWN_DESTRUCTURE_NEEDLE =
  "supportsFileAttachments:w,togglingSwitchRef:T}=e,E=ee(),";
const ATTACHMENT_MENU_DROPDOWN_DESTRUCTURE_PATCH =
  "supportsFileAttachments:w,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,togglingSwitchRef:T}=e,codexLinuxCustomModelCanAddImages=codexLinuxCustomModelSupportsImageInputs!==!1,E=ee(),";
const ATTACHMENT_MENU_ICON_NEEDLE = "le=w?dt:ue,W;";
const ATTACHMENT_MENU_ICON_PATCH = "le=w&&codexLinuxCustomModelCanAddImages?dt:ue,W;";
const ATTACHMENT_MENU_LABEL_CACHE_NEEDLE = "let G;t[28]===w?G=t[29]:(";
const ATTACHMENT_MENU_LABEL_CACHE_PATCH = "let G;false&&t[28]===w?G=t[29]:(";
const ATTACHMENT_MENU_LABEL_NEEDLE =
  "G=w?(0,Q.jsx)(D,{id:`composer.addPhotosAndFiles`,defaultMessage:`Add photos & files`,description:`Dropdown item label to add photos and files to the composer`}):(0,Q.jsx)(D,{id:`composer.addPhotos`,defaultMessage:`Add photos`,description:`Dropdown item label to add photos to the composer`})";
const ATTACHMENT_MENU_LABEL_PATCH =
  "G=w?codexLinuxCustomModelCanAddImages?(0,Q.jsx)(D,{id:`composer.addPhotosAndFiles`,defaultMessage:`Add photos & files`,description:`Dropdown item label to add photos and files to the composer`}):(0,Q.jsx)(D,{id:`composer.addFiles`,defaultMessage:`Add files`,description:`Dropdown item label to add files to the composer`}):(0,Q.jsx)(D,{id:`composer.addPhotos`,defaultMessage:`Add photos`,description:`Dropdown item label to add photos to the composer`})";
const ATTACHMENT_MENU_APPSHOT_NEEDLE = "q=x&&h!=null?(0,Q.jsx)(ae,{electron:!0,children:(0,Q.jsx)(nt,";
const ATTACHMENT_MENU_APPSHOT_PATCH =
  "q=codexLinuxCustomModelCanAddImages&&x&&h!=null?(0,Q.jsx)(ae,{electron:!0,children:(0,Q.jsx)(nt,";
const ATTACHMENT_MENU_APPSHOT_CACHE_NEEDLE =
  "let q;t[34]!==r||t[35]!==h||t[36]!==i||t[37]!==o||t[38]!==c||t[39]!==f||t[40]!==g||t[41]!==_||t[42]!==v||t[43]!==x?(q=codexLinuxCustomModelCanAddImages&&x&&h!=null?";
const ATTACHMENT_MENU_APPSHOT_CACHE_PATCH =
  "let q;true||t[34]!==r||t[35]!==h||t[36]!==i||t[37]!==o||t[38]!==c||t[39]!==f||t[40]!==g||t[41]!==_||t[42]!==v||t[43]!==x?(q=codexLinuxCustomModelCanAddImages&&x&&h!=null?";
const ATTACHMENT_MENU_CURRENT_VARIANTS = {
  destructure: {
    needle: "supportsFileAttachments:T,supportsRemoteFileAttachments:O,onPickBrowserFiles:k,disabled:A}=e,j=T===void 0?!0:T,M=O===void 0?!1:O,P=A===void 0?!1:A,F=a(s),",
    replacement: "supportsFileAttachments:T,supportsRemoteFileAttachments:O,onPickBrowserFiles:k,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,disabled:A}=e,j=T===void 0?!0:T,M=O===void 0?!1:O,P=A===void 0?!1:A,codexLinuxCustomModelCanAddImages=codexLinuxCustomModelSupportsImageInputs!==!1,F=a(s),",
  },
  pickerHandlerCache: {
    needle: "if(t[16]!==_e||t[17]!==P||t[18]!==_||t[19]!==f||t[20]!==I||t[21]!==n||t[22]!==m||t[23]!==k||t[24]!==z||t[25]!==F||t[26]!==ne||t[27]!==p||t[28]!==q||t[29]!==j){we=async function(){",
    replacement: "if(true||t[16]!==_e||t[17]!==P||t[18]!==_||t[19]!==f||t[20]!==I||t[21]!==n||t[22]!==m||t[23]!==k||t[24]!==z||t[25]!==F||t[26]!==ne||t[27]!==p||t[28]!==q||t[29]!==j){we=async function(){",
  },
  picker: {
    needle: "let{images:i,others:a}=At(t),o=[];",
    replacement: "let{images:i,others:a}=codexLinuxCustomModelCanAddImages?At(t):{images:[],others:t},o=[];",
  },
  dropdownPropCache: {
    needle: "let Ie;t[60]!==h||",
    replacement: "let Ie;true||t[60]!==h||",
  },
  dropdownProp: {
    needle: "supportsFileAttachments:j,togglingSwitchRef:B})",
    replacement: "supportsFileAttachments:j,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,togglingSwitchRef:B})",
  },
  dropdownDestructure: {
    needle: "supportsFileAttachments:w,togglingSwitchRef:T}=e,O=E(),",
    replacement: "supportsFileAttachments:w,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,togglingSwitchRef:T}=e,codexLinuxCustomModelCanAddImages=codexLinuxCustomModelSupportsImageInputs!==!1,O=E(),",
  },
  icon: {
    needle: "se=w?gt:ue,G;",
    replacement: "se=w&&codexLinuxCustomModelCanAddImages?gt:ue,G;",
  },
  labelCache: {
    needle: "let le;t[28]===w?le=t[29]:(",
    replacement: "let le;false&&t[28]===w?le=t[29]:(",
  },
  label: {
    needle: "le=w?(0,Q.jsx)(D,{id:`composer.addPhotosAndFiles`,defaultMessage:`Add photos & files`,description:`Dropdown item label to add photos and files to the composer`}):(0,Q.jsx)(D,{id:`composer.addPhotos`,defaultMessage:`Add photos`,description:`Dropdown item label to add photos to the composer`})",
    replacement: "le=w?codexLinuxCustomModelCanAddImages?(0,Q.jsx)(D,{id:`composer.addPhotosAndFiles`,defaultMessage:`Add photos & files`,description:`Dropdown item label to add photos and files to the composer`}):(0,Q.jsx)(D,{id:`composer.addFiles`,defaultMessage:`Add files`,description:`Dropdown item label to add files to the composer`}):(0,Q.jsx)(D,{id:`composer.addPhotos`,defaultMessage:`Add photos`,description:`Dropdown item label to add photos to the composer`})",
  },
  appshot: {
    needle: "q=x&&h!=null?(0,Q.jsx)(ce,{electron:!0,children:(0,Q.jsx)(st,",
    replacement: "q=codexLinuxCustomModelCanAddImages&&x&&h!=null?(0,Q.jsx)(ce,{electron:!0,children:(0,Q.jsx)(st,",
  },
  appshotCache: {
    needle: "let q;t[34]!==r||t[35]!==h||t[36]!==i||t[37]!==o||t[38]!==c||t[39]!==f||t[40]!==g||t[41]!==_||t[42]!==v||t[43]!==x?(q=codexLinuxCustomModelCanAddImages&&x&&h!=null?",
    replacement: "let q;true||t[34]!==r||t[35]!==h||t[36]!==i||t[37]!==o||t[38]!==c||t[39]!==f||t[40]!==g||t[41]!==_||t[42]!==v||t[43]!==x?(q=codexLinuxCustomModelCanAddImages&&x&&h!=null?",
  },
};
const ATTACHMENT_MENU_2026_06_13_VARIANTS = {
  destructure: {
    needle: "supportsFileAttachments:D,supportsRemoteFileAttachments:O,onPickBrowserFiles:k,disabled:A}=e,j=D===void 0?!0:D,N=O===void 0?!1:O,P=A===void 0?!1:A,F=a(s),",
    replacement:
      "supportsFileAttachments:D,supportsRemoteFileAttachments:O,onPickBrowserFiles:k,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,disabled:A}=e,j=D===void 0?!0:D,N=O===void 0?!1:O,P=A===void 0?!1:A,codexLinuxCustomModelCanAddImages=codexLinuxCustomModelSupportsImageInputs!==!1,F=a(s),",
  },
  pickerHandlerCache: {
    needle: "if(t[16]!==_e||t[17]!==P||t[18]!==_||t[19]!==f||t[20]!==L||t[21]!==n||t[22]!==m||t[23]!==k||t[24]!==z||t[25]!==F||t[26]!==ne||t[27]!==p||t[28]!==q||t[29]!==j){we=async function(){",
    replacement:
      "if(true||t[16]!==_e||t[17]!==P||t[18]!==_||t[19]!==f||t[20]!==L||t[21]!==n||t[22]!==m||t[23]!==k||t[24]!==z||t[25]!==F||t[26]!==ne||t[27]!==p||t[28]!==q||t[29]!==j){we=async function(){",
  },
  picker: {
    needle: "let{images:i,others:a}=At(t),o=[];",
    replacement: "let{images:i,others:a}=codexLinuxCustomModelCanAddImages?At(t):{images:[],others:t},o=[];",
  },
  dropdownPropCache: {
    needle: "let Ie;t[60]!==h||",
    replacement: "let Ie;true||t[60]!==h||",
  },
  dropdownProp: {
    needle: "supportsFileAttachments:j,togglingSwitchRef:B})",
    replacement: "supportsFileAttachments:j,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,togglingSwitchRef:B})",
  },
  dropdownDestructure: {
    needle: "supportsFileAttachments:w,togglingSwitchRef:D}=e,O=T(),",
    replacement:
      "supportsFileAttachments:w,supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,togglingSwitchRef:D}=e,codexLinuxCustomModelCanAddImages=codexLinuxCustomModelSupportsImageInputs!==!1,O=T(),",
  },
  icon: {
    needle: "oe=ae,se=w?gt:ue,G;",
    replacement: "oe=ae,se=w&&codexLinuxCustomModelCanAddImages?gt:ue,G;",
  },
  labelCache: {
    needle: "let le;t[32]===w?le=t[33]:(",
    replacement: "let le;false&&t[32]===w?le=t[33]:(",
  },
  label: {
    needle:
      "le=w?(0,Q.jsx)(E,{id:`composer.addPhotosAndFiles`,defaultMessage:`Add photos & files`,description:`Dropdown item label to add photos and files to the composer`}):(0,Q.jsx)(E,{id:`composer.addPhotos`,defaultMessage:`Add photos`,description:`Dropdown item label to add photos to the composer`})",
    replacement:
      "le=w?codexLinuxCustomModelCanAddImages?(0,Q.jsx)(E,{id:`composer.addPhotosAndFiles`,defaultMessage:`Add photos & files`,description:`Dropdown item label to add photos and files to the composer`}):(0,Q.jsx)(E,{id:`composer.addFiles`,defaultMessage:`Add files`,description:`Dropdown item label to add files to the composer`}):(0,Q.jsx)(E,{id:`composer.addPhotos`,defaultMessage:`Add photos`,description:`Dropdown item label to add photos to the composer`})",
  },
  appshot: {
    needle: "q=x&&h!=null?(0,Q.jsx)(ce,{electron:!0,children:(0,Q.jsx)(st,",
    replacement: "q=codexLinuxCustomModelCanAddImages&&x&&h!=null?(0,Q.jsx)(ce,{electron:!0,children:(0,Q.jsx)(st,",
  },
  appshotCache: {
    needle:
      "let q;t[38]!==r||t[39]!==h||t[40]!==i||t[41]!==o||t[42]!==c||t[43]!==f||t[44]!==g||t[45]!==_||t[46]!==v||t[47]!==x?(q=codexLinuxCustomModelCanAddImages&&x&&h!=null?",
    replacement:
      "let q;true||t[38]!==r||t[39]!==h||t[40]!==i||t[41]!==o||t[42]!==c||t[43]!==f||t[44]!==g||t[45]!==_||t[46]!==v||t[47]!==x?(q=codexLinuxCustomModelCanAddImages&&x&&h!=null?",
  },
};

function applyCustomModelPickerVisibilityPatch(source) {
  for (const variant of MODEL_PICKER_VARIANTS) {
    if (source.includes(variant.replacement)) {
      return source;
    }
    if (source.includes(variant.needle)) {
      return source.replace(variant.needle, variant.replacement);
    }
  }

  throw new Error("Required custom model picker patch failed: model allowlist filter needle not found");
}

function applyCustomModelListMergePatch(source) {
  if (MODEL_QUERY_SHIM_PATCHED_REGEX.test(source) && source.includes(MODEL_QUERY_SHIM_HELPER_NAME)) {
    return source;
  }
  const queryMatch = source.match(MODEL_QUERY_SHIM_REGEX);
  if (queryMatch == null) {
    throw new Error("Required custom model catalog patch failed: model query fetch needle not found");
  }
  const insertionMatch = source.match(MODEL_QUERY_SHIM_INSERTION_REGEX);
  const currentInsertionMatch = source.match(MODEL_QUERY_SHIM_CURRENT_INSERTION_REGEX);
  if (insertionMatch == null && currentInsertionMatch == null) {
    throw new Error("Required custom model catalog patch failed: model query insertion point not found");
  }

  const insertionPoint = insertionMatch?.[0] ?? currentInsertionMatch[0];
  return source
    .replace(insertionPoint, `${MODEL_QUERY_SHIM_HELPER_SOURCE}${insertionPoint}`)
    .replace(
      MODEL_QUERY_SHIM_REGEX,
      `queryFn:async()=>codexLinuxCustomModelMergeListModels(await ${queryMatch[1]}(\`list-models-for-host\`,{hostId:${queryMatch[2]},includeHidden:!0,cursor:null,limit:${queryMatch[3]}})),select:`,
    );
}

function applyCustomModelRecentThreadsPatch(source) {
  if (
    RECENT_THREADS_PATCHED_REGEX.test(source) ||
    RECENT_THREADS_PROVIDER_PATCHED_REGEX.test(source) ||
    RECENT_THREADS_PARAMS_PROVIDER_PATCHED_REGEX.test(source)
  ) {
    return source;
  }

  const match = source.match(RECENT_THREADS_REGEX);
  if (match != null) {
    return source.replace(
      RECENT_THREADS_REGEX,
      "listRecentThreads({cursor:$1,limit:$2}){return this.params.requestClient.sendRequest(`thread/list`,{limit:$2,cursor:$1,sortKey:this.recentConversationSortKey,modelProviders:[],archived:!1,sourceKinds:$3})}",
    );
  }

  if (!RECENT_THREADS_PROVIDER_REGEX.test(source)) {
    if (!RECENT_THREADS_PARAMS_PROVIDER_REGEX.test(source)) {
      throw new Error("Required custom model catalog patch failed: recent thread provider filter needle not found");
    }
    return source.replace(RECENT_THREADS_PARAMS_PROVIDER_REGEX, "$1[]$2");
  }

  return source.replace(RECENT_THREADS_PROVIDER_REGEX, "$1[]$2");
}

function applyCustomModelRoutingPatch(source) {
  let patched = source;
  let insertionApplied = false;
  for (const insertion of ROUTING_INSERTION_VARIANTS) {
    if (patched.includes(ROUTING_HELPER_NAME) || !patched.includes(insertion)) {
      continue;
    }
    const helperPrefix = insertion.startsWith("var ") ? "" : "void 0;";
    patched = patched.replace(insertion, `${helperPrefix}${ROUTING_HELPER_SOURCE}${insertion}`);
    insertionApplied = true;
    break;
  }
  if (!insertionApplied && !patched.includes(ROUTING_HELPER_NAME)) {
    const insertionMatch = patched.match(ROUTING_INSERTION_REGEX);
    if (insertionMatch != null) {
      patched = patched.replace(insertionMatch[0], `${ROUTING_HELPER_SOURCE}${insertionMatch[0]}`);
      insertionApplied = true;
    }
  }
  if (!insertionApplied && !patched.includes(ROUTING_HELPER_NAME)) {
    throw new Error("Required custom model catalog patch failed: app-server routing insertion point not found");
  }

  let routingApplied = new RegExp(
    `if\\([A-Za-z_$][\\w$]*=${ROUTING_HELPER_NAME}\\([A-Za-z_$][\\w$]*,[A-Za-z_$][\\w$]*\\),`,
    "u",
  ).test(patched);
  for (let index = 0; index < ROUTING_NEEDLE_VARIANTS.length; index += 1) {
    const needle = ROUTING_NEEDLE_VARIANTS[index];
    const replacement = ROUTING_PATCH_VARIANTS[index];
    if (patched.includes(replacement)) {
      routingApplied = true;
      break;
    }
    if (patched.includes(needle)) {
      patched = patched.replace(needle, replacement);
      routingApplied = true;
      break;
    }
  }
  if (!routingApplied) {
    const routingMatch = patched.match(ROUTING_NEEDLE_REGEX);
    if (routingMatch != null) {
      patched = patched.replace(
        routingMatch[0],
        `let ${routingMatch[1]}=await ${routingMatch[2]}(e,t,()=>this.params.fetchFromHost(\`get-copilot-api-proxy-info\`),n,r,()=>this.buildThreadCodexConfig(n),o,i,${routingMatch[3]});if(${routingMatch[1]}=codexLinuxCustomModelApplyRouting(${routingMatch[1]},e),${routingMatch[1]}=${routingMatch[4]}(${routingMatch[1]},a),`,
      );
      routingApplied = true;
    }
  }
  if (!routingApplied) {
    throw new Error("Required custom model catalog patch failed: start conversation routing needle not found");
  }

  if (
    patched.includes("threadCreation.createConversation") &&
    !CREATE_CONVERSATION_ROUTING_PATCHED_REGEX.test(patched)
  ) {
    const createMatch = patched.match(CREATE_CONVERSATION_ROUTING_REGEX);
    if (createMatch == null) {
      throw new Error("Required custom model catalog patch failed: create conversation routing needle not found");
    }
    patched = patched.replace(
      CREATE_CONVERSATION_ROUTING_REGEX,
      `$1codexLinuxCustomModelApplyRouting({config:$3??{}},$2?.settings?.model).config$4`,
    );
  }

  const autoTitlePatchedRegex =
    /skipAutoTitleGeneration:[A-Za-z_$][\w$]*=codexLinuxCustomModelCustomSlug\([A-Za-z_$][\w$]*\?\.settings\?\.model\)/u;
  if (!autoTitlePatchedRegex.test(patched) && patched.includes("skipAutoTitleGeneration")) {
    const autoTitleRegex =
      /(async startConversation\(\{[^}]{0,1200}?collaborationMode:([A-Za-z_$][\w$]*)[^}]{0,1200}?skipAutoTitleGeneration:[A-Za-z_$][\w$]*=)!1(,additionalDeveloperInstructions:)/u;
    const currentAutoTitleRegex =
      /(async startConversation\([^)]*\)\{let\{[\s\S]{0,1200}?collaborationMode:([A-Za-z_$][\w$]*)[\s\S]{0,1200}?skipAutoTitleGeneration:[A-Za-z_$][\w$]*=)!1(,additionalDeveloperInstructions:)/u;
    const autoTitleMatch = patched.match(autoTitleRegex) ?? patched.match(currentAutoTitleRegex);
    if (autoTitleMatch == null) {
      throw new Error("Required custom model catalog patch failed: custom model auto-title guard needle not found");
    }
    patched = patched.replace(
      autoTitleMatch[0],
      `${autoTitleMatch[1]}codexLinuxCustomModelCustomSlug(${autoTitleMatch[2]}?.settings?.model)${autoTitleMatch[3]}`,
    );
  }

  return patched;
}

function applyCustomModelForkRoutingPatch(source) {
  if (source.includes(FORK_ROUTING_MARKER) && source.includes("sendRequest(`thread/fork`")) {
    return source;
  }
  if (!source.includes(ROUTING_HELPER_NAME)) {
    throw new Error(
      "Required custom model catalog patch failed: routing helper must be injected before fork routing patch",
    );
  }

  const inlineConfigMatch = source.match(FORK_ROUTING_INLINE_CONFIG_REGEX);
  if (inlineConfigMatch != null) {
    return source.replace(
      FORK_ROUTING_INLINE_CONFIG_REGEX,
      (
        _match,
        configVar,
        managerVar,
        cwdVar,
        conversationVar,
        responseVar,
        threadIdVar,
        pathVar,
        threadSourceVar,
      ) =>
        `let ${configVar}=codexLinuxCustomModelApplyRouting({config:await ${managerVar}.buildThreadCodexConfig(${cwdVar}??${conversationVar}?.cwd??null)},${conversationVar}?.latestModel??${conversationVar}?.latestCollaborationMode?.settings?.model??\`\`),${responseVar}=await ${managerVar}.sendRequest(\`thread/fork\`,{threadId:${threadIdVar},path:${pathVar}??null,cwd:${cwdVar},threadSource:${threadSourceVar},...${configVar}.model==null?{}:{model:${configVar}.model},...${configVar}.modelProvider==null?{}:{modelProvider:${configVar}.modelProvider},...${configVar}.config==null?{}:{config:${configVar}.config},`,
    );
  }

  const currentMatch = source.match(FORK_ROUTING_CURRENT_REGEX);
  if (currentMatch != null) {
    return source.replace(
      FORK_ROUTING_CURRENT_REGEX,
      (
        _match,
        configVar,
        managerVar,
        cwdVar,
        conversationVar,
        responseVar,
        threadIdVar,
        pathVar,
        threadSourceVar,
      ) =>
        `let ${configVar}=codexLinuxCustomModelApplyRouting({config:await ${managerVar}.buildThreadCodexConfig(${cwdVar}??${conversationVar}?.cwd??null)},${conversationVar}?.latestModel??${conversationVar}?.latestCollaborationMode?.settings?.model??\`\`),${responseVar}=await ${managerVar}.sendRequest(\`thread/fork\`,{threadId:${threadIdVar},path:${pathVar}??null,cwd:${cwdVar},threadSource:${threadSourceVar},...${configVar}.model==null?{}:{model:${configVar}.model},...${configVar}.modelProvider==null?{}:{modelProvider:${configVar}.modelProvider},...${configVar}.config==null?{}:{config:${configVar}.config},`,
    );
  }

  const match = source.match(FORK_ROUTING_REGEX);
  if (match == null) {
    throw new Error("Required custom model catalog patch failed: fork conversation routing needle not found");
  }

  return source.replace(
    FORK_ROUTING_REGEX,
    (
      _match,
      configVar,
      managerVar,
      cwdVar,
      conversationVar,
      responseVar,
      threadIdVar,
      pathVar,
    ) =>
      `let ${configVar}=codexLinuxCustomModelApplyRouting({config:await ${managerVar}.buildThreadCodexConfig(${cwdVar}??${conversationVar}?.cwd??null)},${conversationVar}?.latestModel??${conversationVar}?.latestCollaborationMode?.settings?.model??\`\`),${responseVar}=await ${managerVar}.sendRequest(\`thread/fork\`,{threadId:${threadIdVar},path:${pathVar}??null,cwd:${cwdVar},threadSource:\`user\`,...${configVar}.model==null?{}:{model:${configVar}.model},...${configVar}.modelProvider==null?{}:{modelProvider:${configVar}.modelProvider},...${configVar}.config==null?{}:{config:${configVar}.config},`,
  );
}

function applyCustomModelThreadSettingsRoutingPatch(source) {
  if (!source.includes("function codexLinuxCustomModelApplyThreadSettings")) {
    throw new Error(
      "Required custom model catalog patch failed: routing helper must be injected before thread settings patch",
    );
  }

  let patched = source;
  if (!THREAD_SETTINGS_UPDATE_PATCHED_REGEX.test(patched)) {
    const match = patched.match(THREAD_SETTINGS_UPDATE_REGEX);
    if (match == null) {
      throw new Error("Required custom model catalog patch failed: thread settings routing needle not found");
    }
    patched = patched.replace(
      THREAD_SETTINGS_UPDATE_REGEX,
      `async updateThreadSettingsForNextTurn(${match[1]},${match[2]}){${match[2]}=codexLinuxCustomModelApplyThreadSettings(${match[2]});let ${match[3]}=this.pendingThreadSettingsUpdates.get(${match[1]}),`,
    );
  }

  if (patched.includes(THREAD_SETTINGS_PROVIDER_RESUME_MARKER)) {
    return patched;
  }
  if (!patched.includes("function codexLinuxCustomModelNeedsProviderResume")) {
    throw new Error(
      "Required custom model catalog patch failed: provider transition helper was not injected",
    );
  }

  const methodMatch = patched.match(
    /async updateThreadSettingsForNextTurn\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{/u,
  );
  if (methodMatch == null) {
    throw new Error("Required custom model catalog patch failed: thread settings method not found");
  }
  const methodStart = methodMatch.index;
  const methodEnd = patched.indexOf("}async waitForPendingThreadSettingsUpdate(", methodStart);
  if (methodEnd < 0) {
    throw new Error("Required custom model catalog patch failed: thread settings method boundary not found");
  }
  const methodSource = patched.slice(methodStart, methodEnd);
  if (!methodSource.includes(THREAD_SETTINGS_PROVIDER_RESUME_NEEDLE)) {
    throw new Error("Required custom model catalog patch failed: provider transition insertion point not found");
  }

  const threadId = methodMatch[1];
  const settings = methodMatch[2];
  const stateUpdaterMatch = methodSource.match(
    new RegExp(
      `this\\.updateConversationState\\(${threadId},[A-Za-z_$][\\w$]*=>\\{([A-Za-z_$][\\w$]*)\\([A-Za-z_$][\\w$]*,${settings}\\)\\}`,
      "u",
    ),
  );
  const stateUpdater = stateUpdaterMatch?.[1] ?? "zp";
  const providerResume =
    `if(codexLinuxCustomModelNeedsProviderResume(this.getConversation(${threadId}),${settings})){` +
    `let codexLinuxTargetModel=${settings}?.model??${settings}?.collaborationMode?.settings?.model??null;` +
    `await this.sendRequest(\`thread/unsubscribe\`,{threadId:${threadId}}),this.streamState.removeConversation(${threadId}),` +
    `this.updateConversationState(${threadId},e=>{${stateUpdater}(e,${settings}),e.resumeState=\`needs_resume\`},!1);` +
    `let codexLinuxConversation=this.getConversation(${threadId});` +
    `await this.resumeConversationForUnavailableOwner({conversationId:${threadId},model:codexLinuxTargetModel,serviceTier:${settings}?.serviceTier??null,reasoningEffort:${settings}?.effort??null,workspaceRoots:[codexLinuxConversation?.cwd??\`/\`],permissions:codexLinuxConversation?.currentPermissions??void 0,collaborationMode:codexLinuxConversation?.latestCollaborationMode??${settings}?.collaborationMode??null});return}`;

  const patchedMethod = methodSource.replace(
    THREAD_SETTINGS_PROVIDER_RESUME_NEEDLE,
    `${providerResume}${THREAD_SETTINGS_PROVIDER_RESUME_NEEDLE}`,
  );
  return `${patched.slice(0, methodStart)}${patchedMethod}${patched.slice(methodEnd)}`;
}

function applyCustomModelTurnStartRoutingPatch(source) {
  if (TURN_START_ROUTING_PATCHED_REGEX.test(source)) {
    return source;
  }
  if (TURN_START_ROUTING_UNSAFE_FALLBACK_PATCHED_REGEX.test(source)) {
    return source.replace(
      TURN_START_ROUTING_UNSAFE_FALLBACK_PATCHED_REGEX,
      (needle, _payloadVar, modelVar, collaborationModeVar, requestParamsVar) =>
        needle.replace(
          `},${modelVar}??${collaborationModeVar}?.settings?.model),${requestParamsVar}={threadId:`,
          `},codexLinuxCustomModelRouteModel(${modelVar},${collaborationModeVar}?.settings?.model)),${requestParamsVar}={threadId:`,
        ),
    );
  }
  if (TURN_START_ROUTING_LEGACY_PATCHED_REGEX.test(source)) {
    return source.replace(
      TURN_START_ROUTING_LEGACY_PATCHED_REGEX,
      (needle, _payloadVar, modelVar, collaborationModeVar, requestParamsVar) =>
        needle.replace(
          `},${modelVar}),${requestParamsVar}={threadId:`,
          `},codexLinuxCustomModelRouteModel(${modelVar},${collaborationModeVar}?.settings?.model)),${requestParamsVar}={threadId:`,
        ),
    );
  }
  if (!source.includes("function codexLinuxCustomModelApplyRouting")) {
    throw new Error(
      "Required custom model catalog patch failed: routing helper must be injected before turn start patch",
    );
  }

  const match = source.match(TURN_START_ROUTING_REGEX);
  if (match == null) {
    throw new Error("Required custom model catalog patch failed: turn start routing needle not found");
  }

  return source.replace(
    TURN_START_ROUTING_REGEX,
    (needle, payloadVar, modelVar, collaborationModeVar, requestParamsVar) =>
      needle
        .replace(`${payloadVar}={threadId:`, `${payloadVar}=codexLinuxCustomModelApplyRouting({threadId:`)
        .replace(
          `},${requestParamsVar}={threadId:`,
          `},codexLinuxCustomModelRouteModel(${modelVar},${collaborationModeVar}?.settings?.model)),${requestParamsVar}={threadId:`,
        ),
  );
}

function applyCustomModelResumeDynamicToolsPatch(source) {
  if (source.includes("skipDynamicTools:!codexLinuxCustomModelSupportsTools")) {
    return source;
  }
  if (source.includes("skipDynamicTools:!codexLinuxCustomModelCustomSlug")) {
    return source.replaceAll(
      "skipDynamicTools:!codexLinuxCustomModelCustomSlug(",
      "skipDynamicTools:!codexLinuxCustomModelSupportsTools(",
    );
  }
  if (!RESUME_SKIP_DYNAMIC_TOOLS_REGEX.test(source)) {
    return source;
  }
  if (!source.includes("function codexLinuxCustomModelSupportsTools")) {
    throw new Error(
      "Required custom model catalog patch failed: tool support helper must be injected before resume dynamic-tools patch",
    );
  }
  return source.replace(RESUME_SKIP_DYNAMIC_TOOLS_REGEX, RESUME_SKIP_DYNAMIC_TOOLS_REPLACEMENT);
}

function applyCustomModelResumeDynamicToolsPayloadPatch(source) {
  if (source.includes(RESUME_DYNAMIC_TOOLS_PAYLOAD_PATCH)) {
    return source;
  }
  if (!source.includes(RESUME_DYNAMIC_TOOLS_PAYLOAD_NEEDLE)) {
    return source;
  }
  if (!source.includes("function codexLinuxCustomModelSupportsTools")) {
    throw new Error(
      "Required custom model catalog patch failed: tool support helper must be injected before resume dynamic-tools payload patch",
    );
  }
  return source.replace(RESUME_DYNAMIC_TOOLS_PAYLOAD_NEEDLE, RESUME_DYNAMIC_TOOLS_PAYLOAD_PATCH);
}

function applyCustomModelTooltipPatch(source) {
  if (
    (source.includes(MODEL_TOOLTIP_PATCH) || /=codexLinuxCustomModelTooltip\([A-Za-z_$][\w$]*,/u.test(source)) &&
    source.includes(MODEL_TOOLTIP_HELPER_NAME)
  ) {
    return source;
  }
  const tooltipMatch = source.match(MODEL_TOOLTIP_MEMO_REGEX);
  if (!source.includes(MODEL_TOOLTIP_NEEDLE) && tooltipMatch == null) {
    throw new Error("Required custom model catalog patch failed: model tooltip needle not found");
  }

  const helperInsertionPoint = "function Om(e){";
  const functionMatch = source.match(MODEL_TOOLTIP_FUNCTION_REGEX);
  if (!source.includes(helperInsertionPoint) && functionMatch == null) {
    throw new Error("Required custom model catalog patch failed: model option render function not found");
  }

  let patched = source;
  const insertionPoint = source.includes(helperInsertionPoint) ? helperInsertionPoint : functionMatch[1];
  const modelOptionVar = source.includes(helperInsertionPoint) ? "r" : functionMatch[2];
  patched = patched.replace(insertionPoint, `${MODEL_TOOLTIP_HELPER_SOURCE}${insertionPoint}`);
  if (patched.includes(MODEL_TOOLTIP_NEEDLE)) {
    return patched.replace(MODEL_TOOLTIP_NEEDLE, MODEL_TOOLTIP_PATCH);
  }
  return patched.replace(
    MODEL_TOOLTIP_MEMO_REGEX,
    `${tooltipMatch[3]}=codexLinuxCustomModelTooltip(${modelOptionVar},${tooltipMatch[4]}(${tooltipMatch[2]})?${tooltipMatch[1]}.replace(/\\.$/u,\`\`):void 0);`,
  );
}

function applyCustomModelProviderGroupPatch(source) {
  if (
    source.includes(MODEL_PROVIDER_GROUP_HELPER_NAME) &&
    (source.includes(MODEL_PROVIDER_GROUP_PATCH) || source.includes(MODEL_PROVIDER_GROUP_CURRENT_PATCH))
  ) {
    return source;
  }
  if (!source.includes(MODEL_PROVIDER_GROUP_NEEDLE) && !source.includes(MODEL_PROVIDER_GROUP_CURRENT_NEEDLE)) {
    throw new Error("Required custom model catalog patch failed: model provider grouping needle not found");
  }
  const insertionMatch = source.match(MODEL_PROVIDER_GROUP_INSERTION_REGEX);
  if (insertionMatch == null) {
    throw new Error("Required custom model catalog patch failed: model provider grouping insertion point not found");
  }

  const needle = source.includes(MODEL_PROVIDER_GROUP_CURRENT_NEEDLE)
    ? MODEL_PROVIDER_GROUP_CURRENT_NEEDLE
    : MODEL_PROVIDER_GROUP_NEEDLE;
  const patch = needle === MODEL_PROVIDER_GROUP_CURRENT_NEEDLE
    ? MODEL_PROVIDER_GROUP_CURRENT_PATCH
    : MODEL_PROVIDER_GROUP_PATCH;

  return source
    .replace(insertionMatch[0], `${MODEL_PROVIDER_GROUP_HELPER_SOURCE}${insertionMatch[0]}`)
    .replace(needle, patch);
}

function applyCustomModelComposerAttachmentPropPatch(source) {
  if (
    source.includes(COMPOSER_ATTACHMENT_PROP_PATCH) ||
    /onOpenGoalEditor:[A-Za-z_$][\w$]*,supportsImageInputs:[A-Za-z_$][\w$]*,supportsFileAttachments:/u.test(source) ||
    /[A-Za-z_$][\w$]*=Qy\(\{[^{}]{0,1200}?setFileAttachments:[A-Za-z_$][\w$]*,supportsImageInputs:[A-Za-z_$][\w$]*,supportsFileAttachments:/u.test(source) ||
    /[A-Za-z_$][\w$]*=lU\(\{[^{}]{0,1800}?setFileAttachments:[A-Za-z_$][\w$]*,supportsImageInputs:[A-Za-z_$][\w$]*,supportsFileAttachments:/u.test(source)
  ) {
    return source;
  }
  if (source.includes(COMPOSER_ATTACHMENT_PROP_NEEDLE)) {
    return source.replace(COMPOSER_ATTACHMENT_PROP_NEEDLE, COMPOSER_ATTACHMENT_PROP_PATCH);
  }

  const capabilityMatch = source.match(COMPOSER_IMAGE_CAPABILITY_REGEX) ?? source.match(COMPOSER_IMAGE_HOOK_RESULT_REGEX);
  const currentPropMatch = source.match(
    /([A-Za-z_$][\w$]*=Qy\(\{[^{}]{0,1200}?setFileAttachments:[A-Za-z_$][\w$]*,)(supportsFileAttachments:)/u,
  );
  if (capabilityMatch != null && currentPropMatch != null) {
    return source.replace(
      currentPropMatch[0],
      `${currentPropMatch[1]}supportsImageInputs:${capabilityMatch[1]},${currentPropMatch[2]}`,
    );
  }
  const currentAttachmentMenuMatch = source.match(
    /([A-Za-z_$][\w$]*=lU\(\{[^{}]{0,1800}?setFileAttachments:[A-Za-z_$][\w$]*,)(supportsFileAttachments:)/u,
  );
  if (capabilityMatch != null && currentAttachmentMenuMatch != null) {
    return source.replace(
      currentAttachmentMenuMatch[0],
      `${currentAttachmentMenuMatch[1]}supportsImageInputs:${capabilityMatch[1]},${currentAttachmentMenuMatch[2]}`,
    );
  }
  const propMatch = source.match(COMPOSER_ATTACHMENT_PROP_REGEX);
  if (capabilityMatch == null || propMatch == null) {
    throw new Error("Required custom model catalog patch failed: composer attachment prop needle not found");
  }

  return source.replace(
    COMPOSER_ATTACHMENT_PROP_REGEX,
    `onOpenGoalEditor:${propMatch[1]},supportsImageInputs:${capabilityMatch[1]},supportsFileAttachments:`,
  );
}

function replaceRequiredVariant(source, variants, description) {
  for (const variant of variants) {
    if (source.includes(variant.replacement)) {
      return source;
    }
  }
  for (const variant of variants) {
    if (source.includes(variant.needle)) {
      return source.replace(variant.needle, variant.replacement);
    }
  }
  throw new Error(`Required custom model catalog patch failed: ${description} needle not found`);
}

function applyCustomModelAttachmentMenuPatch(source) {
  if (source.includes("codexLinuxOtherFiles=e.supportsImageInputs?r:[...r,...n]")) {
    return source;
  }
  const electron42MenuMatch = source.match(
    /function ([A-Za-z_$][\w$]*)\(e\)\{let t=\[\{disabled:!1,icon:e\.supportsFileAttachments\?`paperclip`:`image`,id:`pick-local-files`,label:e\.supportsFileAttachments\?e\.labels\.filesAndFolders:e\.labels\.addPhotos,run:\(\)=>([A-Za-z_$][\w$]*)\(e\)\}\]/u,
  );
  if (electron42MenuMatch != null && source.includes(`async function ${electron42MenuMatch[2]}(e){`)) {
    const pickerFunctionName = electron42MenuMatch[2];
    let current = source.replaceAll(
      "||codexLinuxOtherFiles.length===0",
      "||r.length===0",
    );
    const pickerStart = current.indexOf(`async function ${pickerFunctionName}(e){`);
    const pickerEnd = current.indexOf("function ", pickerStart + `async function ${pickerFunctionName}(e){`.length);
    if (pickerEnd === -1) {
      throw new Error("Required custom model catalog patch failed: Electron 42 attachment picker boundary not found");
    }
    let pickerSource = current.slice(pickerStart, pickerEnd);
    if (pickerSource.includes("codexLinuxOtherFiles=e.supportsImageInputs?r:[...r,...n]")) {
      pickerSource = pickerSource.replace(
        "!e.supportsFileAttachments||r.length===0",
        "!e.supportsFileAttachments||codexLinuxOtherFiles.length===0",
      );
      return current.slice(0, pickerStart) + pickerSource + current.slice(pickerEnd);
    }
    current = current.replace(
      "icon:e.supportsFileAttachments?`paperclip`:`image`",
      "icon:e.supportsFileAttachments||!e.supportsImageInputs?`paperclip`:`image`",
    );
    current = current.replace(
      "label:e.supportsFileAttachments?e.labels.filesAndFolders:e.labels.addPhotos",
      "label:e.supportsFileAttachments||!e.supportsImageInputs?e.labels.filesAndFolders:e.labels.addPhotos",
    );
    current = current.replace(
      "imagesOnly:!e.supportsFileAttachments",
      "imagesOnly:!e.supportsFileAttachments&&e.supportsImageInputs",
    );
    current = current.replace(
      ",i=n.length===0?[]:await e.loadImageDataUrls(n);",
      ",codexLinuxOtherFiles=e.supportsImageInputs?r:[...r,...n],i=e.supportsImageInputs&&n.length!==0?await e.loadImageDataUrls(n):[];",
    );
    const updatedPickerStart = current.indexOf(`async function ${pickerFunctionName}(e){`);
    const updatedPickerEnd = current.indexOf(
      "function ",
      updatedPickerStart + `async function ${pickerFunctionName}(e){`.length,
    );
    pickerSource = current.slice(updatedPickerStart, updatedPickerEnd).replace(
      "!e.supportsFileAttachments||r.length===0",
      "!e.supportsFileAttachments||codexLinuxOtherFiles.length===0",
    );
    current = current.slice(0, updatedPickerStart) + pickerSource + current.slice(updatedPickerEnd);
    current = current.replace("uploadLocalFileAttachments(r)", "uploadLocalFileAttachments(codexLinuxOtherFiles)");
    current = current.replace("addFileAttachments(r)", "addFileAttachments(codexLinuxOtherFiles)");
    current = current.replace(
      /(supportsFileAttachments:[A-Za-z_$][\w$]*,)(supportsRemoteFileAttachments:[A-Za-z_$][\w$]*\}=e)/u,
      "$1supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,$2",
    );
    current = current.replace(
      /(supportsFileAttachments:[A-Za-z_$][\w$]*,)(uploadLocalFileAttachments:)/u,
      "$1supportsImageInputs:codexLinuxCustomModelSupportsImageInputs,$2",
    );
    if (current === source || !current.includes("codexLinuxOtherFiles=e.supportsImageInputs?r:[...r,...n]")) {
      throw new Error("Required custom model catalog patch failed: Electron 42 attachment menu needle not found");
    }
    return current;
  }

  let patched = source;
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_DESTRUCTURE_NEEDLE, replacement: ATTACHMENT_MENU_DESTRUCTURE_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.destructure,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.destructure,
    ],
    "attachment menu image capability prop",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_PICKER_HANDLER_CACHE_NEEDLE, replacement: ATTACHMENT_MENU_PICKER_HANDLER_CACHE_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.pickerHandlerCache,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.pickerHandlerCache,
    ],
    "attachment menu image picker cache key",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_PICKER_NEEDLE, replacement: ATTACHMENT_MENU_PICKER_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.picker,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.picker,
    ],
    "attachment menu image picker split",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_DROPDOWN_PROP_CACHE_NEEDLE, replacement: ATTACHMENT_MENU_DROPDOWN_PROP_CACHE_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.dropdownPropCache,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.dropdownPropCache,
    ],
    "attachment dropdown capability prop cache key",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_DROPDOWN_PROP_NEEDLE, replacement: ATTACHMENT_MENU_DROPDOWN_PROP_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.dropdownProp,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.dropdownProp,
    ],
    "attachment dropdown capability prop",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_DROPDOWN_DESTRUCTURE_NEEDLE, replacement: ATTACHMENT_MENU_DROPDOWN_DESTRUCTURE_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.dropdownDestructure,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.dropdownDestructure,
    ],
    "attachment dropdown capability prop receiver",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_ICON_NEEDLE, replacement: ATTACHMENT_MENU_ICON_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.icon,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.icon,
    ],
    "attachment menu file icon",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_LABEL_CACHE_NEEDLE, replacement: ATTACHMENT_MENU_LABEL_CACHE_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.labelCache,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.labelCache,
    ],
    "attachment menu file label cache key",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_LABEL_NEEDLE, replacement: ATTACHMENT_MENU_LABEL_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.label,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.label,
    ],
    "attachment menu file label",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_APPSHOT_NEEDLE, replacement: ATTACHMENT_MENU_APPSHOT_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.appshot,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.appshot,
    ],
    "attachment menu appshot gate",
  );
  patched = replaceRequiredVariant(
    patched,
    [
      { needle: ATTACHMENT_MENU_APPSHOT_CACHE_NEEDLE, replacement: ATTACHMENT_MENU_APPSHOT_CACHE_PATCH },
      ATTACHMENT_MENU_CURRENT_VARIANTS.appshotCache,
      ATTACHMENT_MENU_2026_06_13_VARIANTS.appshotCache,
    ],
    "attachment menu appshot cache key",
  );
  return patched;
}

const MODEL_PICKER_ASSET_PATTERN =
  /^(?:model-list-filter-.*|app-initial~app-main~onboarding-page-[A-Za-z0-9_-]+)\.js$/;
const MODEL_QUERY_ASSET_PATTERN =
  /^(?:model-queries-.*|app-initial~app-main~onboarding-page-[A-Za-z0-9_-]+)\.js$/;
const ROUTING_ASSET_PATTERN =
  /^(?:thread-context-inputs-.*|app-initial~app-main~worktree-init-v2-page~remote-conversation-page~new-thread-panel-page~o~[A-Za-z0-9_-]+)\.js$/;
const MODEL_DROPDOWN_ASSET_PATTERN =
  /^(?:model-and-reasoning-dropdown-[A-Za-z0-9_-]+|app-initial~app-main~onboarding-page-[A-Za-z0-9_-]+)\.js$/;
const COMPOSER_ASSET_PATTERN =
  /^(?:composer-(?!controller-)[A-Za-z0-9_-]+|app-initial~app-main~remote-conversation-page~new-thread-panel-page~appgen-library-page~hot~[A-Za-z0-9_-]+)\.js$/;

const descriptors = [
  {
    id: "model-picker-visibility",
    phase: "webview-asset",
    order: 19_000,
    ciPolicy: "required-upstream",
    pattern: MODEL_PICKER_ASSET_PATTERN,
    assetMarker: "amazonBedrock",
    missingDescription: "model picker model query bundle",
    apply: applyCustomModelPickerVisibilityPatch,
  },
  {
    id: "model-list-shim-catalog",
    phase: "webview-asset",
    order: 19_010,
    ciPolicy: "required-upstream",
    pattern: MODEL_QUERY_ASSET_PATTERN,
    assetMarker: "`list-models-for-host`",
    missingDescription: "model query bundle",
    apply: applyCustomModelListMergePatch,
  },
  {
    id: "start-conversation-routing",
    phase: "webview-asset",
    order: 19_020,
    ciPolicy: "required-upstream",
    pattern: ROUTING_ASSET_PATTERN,
    assetMarker: "`get-copilot-api-proxy-info`",
    missingDescription: "app-server manager signals bundle",
    apply: applyCustomModelRoutingPatch,
  },
  {
    id: "existing-thread-settings-routing",
    phase: "webview-asset",
    order: 19_021,
    ciPolicy: "required-upstream",
    pattern: ROUTING_ASSET_PATTERN,
    assetMarker: "updateThreadSettingsForNextTurn",
    missingDescription: "app-server manager signals bundle",
    apply: applyCustomModelThreadSettingsRoutingPatch,
  },
  {
    id: "existing-thread-turn-start-routing",
    phase: "webview-asset",
    order: 19_022,
    ciPolicy: "required-upstream",
    pattern: ROUTING_ASSET_PATTERN,
    assetMarker: "`turn/start`",
    missingDescription: "app-server manager signals bundle",
    apply: applyCustomModelTurnStartRoutingPatch,
  },
  {
    id: "fork-conversation-routing",
    phase: "webview-asset",
    order: 19_023,
    ciPolicy: "required-upstream",
    pattern: ROUTING_ASSET_PATTERN,
    assetMarker: "`thread/fork`",
    missingDescription: "app-server manager signals bundle",
    apply: applyCustomModelForkRoutingPatch,
  },
  {
    id: "resume-dynamic-tools-for-custom-slugs",
    phase: "webview-asset",
    order: 19_025,
    ciPolicy: "optional",
    pattern: ROUTING_ASSET_PATTERN,
    assetMarker: "skipDynamicTools",
    missingDescription: "app-server manager signals bundle",
    apply: applyCustomModelResumeDynamicToolsPatch,
  },
  {
    id: "resume-forward-dynamic-tools-payload",
    phase: "webview-asset",
    order: 19_026,
    ciPolicy: "optional",
    pattern: ROUTING_ASSET_PATTERN,
    missingDescription: "app-server manager signals bundle",
    apply: applyCustomModelResumeDynamicToolsPayloadPatch,
  },
  {
    id: "recent-thread-provider-filter",
    phase: "webview-asset",
    order: 19_030,
    ciPolicy: "required-upstream",
    pattern: ROUTING_ASSET_PATTERN,
    assetMarker: "listRecentThreads",
    missingDescription: "app-server manager signals bundle",
    apply: applyCustomModelRecentThreadsPatch,
  },
  {
    id: "model-tooltip-details",
    phase: "webview-asset",
    order: 19_040,
    ciPolicy: "required-upstream",
    pattern: MODEL_DROPDOWN_ASSET_PATTERN,
    assetMarker: "modelOption:",
    missingDescription: "composer model picker bundle",
    apply: applyCustomModelTooltipPatch,
  },
  {
    id: "model-provider-groups",
    phase: "webview-asset",
    order: 19_041,
    ciPolicy: "required-upstream",
    pattern: MODEL_DROPDOWN_ASSET_PATTERN,
    assetMarker: (source) =>
      source.includes("composer.intelligenceDropdown.model.title") ||
      source.includes(MODEL_PROVIDER_GROUP_NEEDLE) ||
      source.includes(MODEL_PROVIDER_GROUP_CURRENT_NEEDLE),
    missingDescription: "composer model picker bundle",
    apply: applyCustomModelProviderGroupPatch,
  },
  {
    id: "composer-attachment-image-affordance-prop",
    phase: "webview-asset",
    order: 19_045,
    ciPolicy: "required-upstream",
    pattern: COMPOSER_ASSET_PATTERN,
    assetMarker: "supportsFileAttachments",
    missingDescription: "composer bundle",
    apply: applyCustomModelComposerAttachmentPropPatch,
  },
  {
    id: "attachment-menu-image-affordance",
    phase: "webview-asset",
    order: 19_046,
    ciPolicy: "required-upstream",
    pattern: COMPOSER_ASSET_PATTERN,
    assetMarker: "supportsFileAttachments",
    missingDescription: "composer attachment menu bundle",
    apply: applyCustomModelAttachmentMenuPatch,
  },
];

module.exports = {
  MODEL_PICKER_VARIANTS,
  MODEL_QUERY_SHIM_HELPER_SOURCE,
  MODEL_QUERY_SHIM_PATCH,
  MODEL_TOOLTIP_HELPER_SOURCE,
  MODEL_TOOLTIP_NEEDLE,
  MODEL_TOOLTIP_PATCH,
  MODEL_PROVIDER_GROUP_HELPER_SOURCE,
  MODEL_PROVIDER_GROUP_PATCH,
  ROUTING_HELPER_SOURCE,
  ROUTING_PATCH,
  ROUTING_PATCH_VARIANTS,
  FORK_ROUTING_MARKER,
  RESUME_SKIP_DYNAMIC_TOOLS_REPLACEMENT,
  RESUME_DYNAMIC_TOOLS_PAYLOAD_PATCH,
  applyCustomModelForkRoutingPatch,
  applyCustomModelThreadSettingsRoutingPatch,
  applyCustomModelTurnStartRoutingPatch,
  applyCustomModelResumeDynamicToolsPatch,
  applyCustomModelResumeDynamicToolsPayloadPatch,
  applyCustomModelAttachmentMenuPatch,
  applyCustomModelComposerAttachmentPropPatch,
  applyCustomModelListMergePatch,
  applyCustomModelPickerVisibilityPatch,
  applyCustomModelProviderGroupPatch,
  applyCustomModelRecentThreadsPatch,
  applyCustomModelRoutingPatch,
  applyCustomModelTooltipPatch,
  descriptors,
};
