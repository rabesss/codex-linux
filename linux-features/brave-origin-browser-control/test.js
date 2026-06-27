#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureStageHooks,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyBraveOriginChromeExtensionStatusPatch,
} = require("./patch.js");

const FEATURE_ID = "brave-origin-browser-control";
const EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";
const repoRoot = path.resolve(__dirname, "..", "..");

function withTempFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-brave-origin-feature-root-"));
  try {
    fs.writeFileSync(path.join(root, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    fs.cpSync(__dirname, path.join(root, FEATURE_ID), { recursive: true });
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeFakeChromePlugin(pluginDir) {
  const scriptsDir = path.join(pluginDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, "installManifest.mjs"),
    `var n={extensionId:"${EXTENSION_ID}",extensionHostName:"com.openai.codexextension"};var p=o=>{let t=\`\${o.extensionHostName}.json\`,r={darwin:["Library/Application Support/Google/Chrome/NativeMessagingHosts"],linux:[".config/google-chrome/NativeMessagingHosts"],win32:["AppData/Local/OpenAI/extension"]}[m.platform()];return r.map(s=>l.resolve(m.homedir(),s,t))};\n`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "browser-client.mjs"),
    'import{resolve as GF}from"path";import{homedir as VF,platform as WF}from"os";var Tc=GF(VF(),WF()==="win32"?"AppData\\\\Local\\\\Google\\\\Chrome\\\\User Data":"Library/Application Support/Google/Chrome");var IS=async(t,e)=>{let r=Gf(Tc,t,"Local Extension Settings",e);if(!XF(r))return null;let n=await JF(Gf(QF(),"codex"));await ZF(r,n,{recursive:!0}),await kS(Gf(n,"LOCK"));let o=new KF(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await kS(n,{force:!0,recursive:!0})}};var AS=async t=>t,rO=async(t,e)=>(await nO(t)).find(o=>o.instanceId===e)||null,nO=async t=>{let e=await oO();return await Promise.all(e.map(async r=>({...r,instanceId:await IS(r.id,t).catch(n=>(ee(n),null))})))},oO=async()=>{let t=tO(Tc,"Local State"),e=JSON.parse(await eO(t,"utf8"));return e.profile.profiles_order.map((r,n)=>{let o=e.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:e.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)};\n',
  );
  fs.writeFileSync(
    path.join(scriptsDir, "check-native-host-manifest.js"),
    `function getNativeHostManifestLocation() {
  if (process.platform === "win32") {
    const registryKey = \`\${WINDOWS_NATIVE_HOST_REGISTRY_KEY_PREFIX}\\\\\${expectedHostName}\`;
    const registryManifestPath = readWindowsRegistryDefaultValue(registryKey);

    return {
      manifestPath: registryManifestPath || getDefaultWindowsManifestPath(),
      registryKey,
      registryManifestPath,
      registryKeyExists: registryManifestPath != null,
    };
  }

  throw new Error(
    \`Unsupported platform for native host manifest check: \${process.platform}. This script supports macOS and Windows.\`,
  );
}
`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "installed-browsers.js"),
    `const KNOWN_BROWSERS = [
  {
    name: "Google Chrome",
    bundleIds: ["com.google.Chrome"],
    appNames: ["Google Chrome.app"],
    commands: ["google-chrome", "chrome"],
    windowsExecutable: "chrome.exe",
  },
];
`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "chrome-is-running.js"),
    `const CHROME_PROCESS_NAMES_BY_PLATFORM = {
  darwin: new Set(["Google Chrome", "Google Chrome Helper"]),
  win32: new Set(["chrome.exe"]),
};
`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "check-extension-installed.js"),
    `function resolveChromeUserDataDirectory() {
  return path.join(os.homedir(), ".config", "google-chrome");
}

function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {
  return userDataDirectory;
}
`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "open-chrome-window.js"),
    `function resolveChromeUserDataDirectory() {
  return path.join(os.homedir(), ".config", "google-chrome");
}

function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {
  return userDataDirectory;
}

function getOpenChromeCommand(profileDirectory) {
  const chromeArgs = [
    \`--profile-directory=\${profileDirectory}\`,
    "--new-window",
    ABOUT_BLANK_URL,
  ];

  return {
    command: "google-chrome",
    args: chromeArgs,
  };
}
`,
  );
}

function currentChromeBrowserClientFixture() {
  return String.raw`import{readFile as a$}from"fs/promises";import{resolve as u$}from"path";import{resolve as Xq}from"path";import{homedir as Qq,platform as e$}from"os";var ld=Xq(Qq(),e$()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");import{ClassicLevel as t$}from"./node_modules/classic-level.mjs";import{resolve as Zh}from"path";import{tmpdir as r$}from"os";import{cp as n$,mkdtemp as o$,rm as YA}from"fs/promises";import{existsSync as i$}from"fs";var ZA=async(e,t)=>{let r=Zh(ld,e,"Local Extension Settings",t);if(!i$(r))return null;let n=await o$(Zh(s$(),"codex"));await n$(r,n,{recursive:!0}),await YA(Zh(n,"LOCK"));let o=new t$(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await YA(n,{force:!0,recursive:!0})}},s$=()=>"nodeRepl"in globalThis&&globalThis.nodeRepl?globalThis.nodeRepl.tmpDir:r$();var XA=async e=>{if(e.type!=="extension"||!e.metadata?.extensionInstanceId||!e.metadata.extensionId)return e;let t=await l$(e.metadata.extensionId,e.metadata.extensionInstanceId);return t?{...e,metadata:{...e.metadata,profileName:t.name,profileIsLastUsed:t.isLastUsed.toString(),profileOrdering:t.orderingIndex.toString()}}:e},l$=async(e,t)=>(await c$(e)).find(o=>o.instanceId===t)||null,c$=async e=>{let t=await d$();return await Promise.all(t.map(async r=>({...r,instanceId:await ZA(r.id,e).catch(n=>(ue(n),null))})))},d$=async()=>{let e=u$(ld,"Local State"),t=JSON.parse(await a$(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)};var Qh=Xy(p$.platform()),f$=async(e,{codexSessionId:t})=>{let r=Vu(Vy),n=e.filter(i=>i.info.type==="iab"),o=m$(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},m$=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));`;
}

function june10ChromeBrowserClientFixture() {
  return String.raw`import C$,{platform as ck}from"node:os";import{readFile as w$}from"fs/promises";import{resolve as x$}from"path";import{resolve as d$}from"path";import{homedir as p$,platform as f$}from"os";var cd=d$(p$(),f$()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");import{ClassicLevel as m$}from"./node_modules/classic-level.mjs";import{resolve as Zh}from"path";import{tmpdir as h$}from"os";import{cp as g$,mkdtemp as b$,rm as sk}from"fs/promises";import{existsSync as y$}from"fs";var ak=async(e,t)=>{let r=Zh(cd,e,"Local Extension Settings",t);if(!y$(r))return null;let n=await b$(Zh(_$(),"codex"));await g$(r,n,{recursive:!0}),await sk(Zh(n,"LOCK"));let o=new m$(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await sk(n,{force:!0,recursive:!0})}},_$=()=>"nodeRepl"in globalThis&&globalThis.nodeRepl?globalThis.nodeRepl.tmpDir:h$();var S$=async(e,t)=>(await v$(e)).find(o=>o.instanceId===t)||null,v$=async e=>{let t=await E$();return await Promise.all(t.map(async r=>({...r,instanceId:await ak(r.id,e).catch(n=>(ue(n),null))})))},E$=async()=>{let e=x$(cd,"Local State"),t=JSON.parse(await w$(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)};var A$=async(e,{codexSessionId:t})=>{let r=Gu(Vy),n=e.filter(i=>i.info.type==="iab"),o=k$(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},k$=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));`;
}

function june13ChromeBrowserClientFixture() {
  return String.raw`import O$,{platform as gk}from"node:os";import{readFile as I$}from"fs/promises";import{resolve as R$}from"path";import{resolve as w$}from"path";import{homedir as x$,platform as S$}from"os";var md=w$(x$(),S$()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");import{ClassicLevel as v$}from"./node_modules/classic-level.mjs";import{resolve as og}from"path";import{tmpdir as E$}from"os";import{cp as C$,mkdtemp as T$,rm as pk}from"fs/promises";import{existsSync as A$}from"fs";var fk=async(e,t)=>{let r=og(md,e,"Local Extension Settings",t);if(!A$(r))return null;let n=await T$(og(k$(),"codex"));await C$(r,n,{recursive:!0}),await pk(og(n,"LOCK"));let o=new v$(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await pk(n,{force:!0,recursive:!0})}},k$=()=>"nodeRepl"in globalThis&&globalThis.nodeRepl?globalThis.nodeRepl.tmpDir:E$();var mk=async e=>{if(e.type!=="extension"||!e.metadata?.extensionInstanceId||!e.metadata.extensionId)return e;let t=await P$(e.metadata.extensionId,e.metadata.extensionInstanceId);return t?{...e,metadata:{...e.metadata,profileName:t.name,profileIsLastUsed:t.isLastUsed.toString(),profileOrdering:t.orderingIndex.toString()}}:e},P$=async(e,t)=>(await D$(e)).find(o=>o.instanceId===t)||null,D$=async e=>{let t=await N$();return await Promise.all(t.map(async r=>({...r,instanceId:await fk(r.id,e).catch(n=>(ue(n),null))})))},N$=async()=>{let e=R$(md,"Local State"),t=JSON.parse(await I$(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)};var F$=async(e,{codexSessionId:t})=>{let r=Ju(e_),n=e.filter(i=>i.info.type==="iab"),o=B$(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},B$=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));`;
}

function electron42CorePatchedBrowserClientFixture() {
  return String.raw`var Rd=z7(W7(),H7()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>H7()==="linux"?[z7(W7(),".config","BraveSoftware","Brave-Browser"),z7(W7(),".config","google-chrome"),z7(W7(),".config","google-chrome-beta"),z7(W7(),".config","google-chrome-unstable"),z7(W7(),".config","chromium")]:[Rd];`;
}

function currentElectron42CorePatchedBrowserClientFixture() {
  return String.raw`var Xd=dH(pH(),fH()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>fH()==="linux"?[dH(pH(),".config","BraveSoftware","Brave-Browser"),dH(pH(),".config","google-chrome"),dH(pH(),".config","google-chrome-beta"),dH(pH(),".config","google-chrome-unstable"),dH(pH(),".config","chromium")]:[Xd];`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

test("Brave Origin browser-control feature stays disabled until listed in features.json", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("Brave Origin browser-control feature exposes its patch and stage hook when enabled", () => {
  withTempFeatureRoot([FEATURE_ID], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), [FEATURE_ID]);
    assert.equal(enabledLinuxFeatureStageHooks({ featuresRoot: root }).length, 1);
    assert.equal(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }).length, 1);
  });
});

test("Brave Origin settings patch extends the core Linux Chrome status helper", () => {
  const source =
    "function codexLinuxChromeProfileRoots({homeDir:e,platform:t}){return t===`linux`?[(0,p.join)(e,`.config`,`BraveSoftware`,`Brave-Browser`),(0,p.join)(e,`.config`,`google-chrome`),(0,p.join)(e,`.config`,`google-chrome-beta`),(0,p.join)(e,`.config`,`google-chrome-unstable`),(0,p.join)(e,`.config`,`chromium`)]:[]}function codexLinuxChromeCommand(){for(let t of[`brave-browser`,`brave`,`google-chrome`,`google-chrome-stable`,`chromium-browser`,`chromium`]){}}throw Error(`Google Chrome, Brave, or Chromium is not installed`)";
  const patched = applyBraveOriginChromeExtensionStatusPatch(source);

  assert.match(patched, /`Brave-Origin-Nightly`/);
  assert.match(patched, /`brave-origin-nightly`/);
  assert.match(patched, /Brave Origin Nightly, Google Chrome, Brave, or Chromium is not installed/);
});

test("Brave Origin stage hook upgrades a core Linux-patched Chrome plugin", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-brave-origin-stage-"));
  try {
    const installDir = path.join(workspace, "install");
    const workDir = path.join(workspace, "work");
    const chromePlugin = path.join(installDir, "resources", "plugins", "openai-bundled", "plugins", "chrome");
    const featuresConfig = path.join(workspace, "features.json");

    fs.mkdirSync(workDir, { recursive: true });
    writeFakeChromePlugin(chromePlugin);
    fs.writeFileSync(featuresConfig, JSON.stringify({ enabled: [FEATURE_ID] }, null, 2));

    run("node", [path.join(repoRoot, "scripts", "lib", "patch-chrome-plugin.js"), chromePlugin]);
    run("bash", [
      "-lc",
      [
        "source \"$LINUX_FEATURES_RUNNER\"",
        "info(){ echo \"$*\" >&2; }",
        "warn(){ echo \"$*\" >&2; }",
        "SCRIPT_DIR=\"$REPO_ROOT\"",
        "INSTALL_DIR=\"$INSTALL_DIR\"",
        "WORK_DIR=\"$WORK_DIR\"",
        "ARCH=x86_64",
        "run_linux_feature_stage_hooks",
      ].join("\n"),
    ], {
      env: {
        ...process.env,
        CODEX_LINUX_FEATURES_CONFIG: featuresConfig,
        LINUX_FEATURES_RUNNER: path.join(repoRoot, "scripts", "lib", "linux-features.sh"),
        REPO_ROOT: repoRoot,
        INSTALL_DIR: installDir,
        WORK_DIR: workDir,
      },
    });

    const scriptsDir = path.join(chromePlugin, "scripts");
    assert.match(fs.readFileSync(path.join(scriptsDir, "installManifest.mjs"), "utf8"), /Brave-Origin-Nightly\/NativeMessagingHosts/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "installManifest.mjs"), "utf8"), new RegExp(EXTENSION_ID));
    assert.match(fs.readFileSync(path.join(scriptsDir, "check-native-host-manifest.js"), "utf8"), /"Brave-Origin-Nightly"/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "browser-client.mjs"), "utf8"), /"\.config","BraveSoftware","Brave-Origin-Nightly"/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "installed-browsers.js"), "utf8"), /Brave Origin Nightly/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "chrome-is-running.js"), "utf8"), /brave-origin-nightly/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "check-extension-installed.js"), "utf8"), /linuxBraveOriginUserDataDirectory/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "open-chrome-window.js"), "utf8"), /commandPath\("brave-origin-nightly"\)/);
    assert.equal(
      fs.readFileSync(path.join(installDir, ".codex-linux", "chrome-native-host-manifest-paths"), "utf8").trim(),
      ".config/BraveSoftware/Brave-Origin-Nightly/NativeMessagingHosts",
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Brave Origin patcher upgrades current Chrome browser-client profile roots", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-brave-origin-current-client-"));
  try {
    const chromePlugin = path.join(workspace, "chrome");
    const scriptsDir = path.join(chromePlugin, "scripts");

    writeFakeChromePlugin(chromePlugin);
    fs.writeFileSync(path.join(scriptsDir, "browser-client.mjs"), currentChromeBrowserClientFixture());

    run("node", [path.join(repoRoot, "scripts", "lib", "patch-chrome-plugin.js"), chromePlugin]);
    run("node", [path.join(repoRoot, "linux-features", FEATURE_ID, "patch-chrome-plugin.js"), chromePlugin]);

    const source = fs.readFileSync(path.join(scriptsDir, "browser-client.mjs"), "utf8");
    assert.match(source, /"\.config","BraveSoftware","Brave-Origin-Nightly"/);
    assert.match(source, /"\.config","BraveSoftware","Brave-Browser"/);
    assert.match(source, /instanceId:await ZA\(o\.id,e,r\)/);
    assert.match(source, /codexLinuxRankBrowserBackends/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Brave Origin patcher upgrades the June 10 Chrome browser-client bundle", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-brave-origin-june10-client-"));
  try {
    const chromePlugin = path.join(workspace, "chrome");
    const scriptsDir = path.join(chromePlugin, "scripts");

    writeFakeChromePlugin(chromePlugin);
    fs.writeFileSync(path.join(scriptsDir, "browser-client.mjs"), june10ChromeBrowserClientFixture());

    run("node", [path.join(repoRoot, "scripts", "lib", "patch-chrome-plugin.js"), chromePlugin]);
    run("node", [path.join(repoRoot, "linux-features", FEATURE_ID, "patch-chrome-plugin.js"), chromePlugin]);

    const source = fs.readFileSync(path.join(scriptsDir, "browser-client.mjs"), "utf8");
    assert.match(source, /"\.config","BraveSoftware","Brave-Origin-Nightly"/);
    assert.match(source, /instanceId:await ak\(o\.id,e,r\)/);
    assert.match(source, /codexLinuxRankBrowserBackends/);
    assert.match(source, /C\$\.platform\(\)!=="linux"/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Brave Origin patcher upgrades the June 13 Chrome browser-client bundle", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-brave-origin-june13-client-"));
  try {
    const chromePlugin = path.join(workspace, "chrome");
    const scriptsDir = path.join(chromePlugin, "scripts");

    writeFakeChromePlugin(chromePlugin);
    fs.writeFileSync(path.join(scriptsDir, "browser-client.mjs"), june13ChromeBrowserClientFixture());

    run("node", [path.join(repoRoot, "scripts", "lib", "patch-chrome-plugin.js"), chromePlugin]);
    run("node", [path.join(repoRoot, "linux-features", FEATURE_ID, "patch-chrome-plugin.js"), chromePlugin]);

    const source = fs.readFileSync(path.join(scriptsDir, "browser-client.mjs"), "utf8");
    assert.match(source, /"\.config","BraveSoftware","Brave-Origin-Nightly"/);
    assert.match(source, /instanceId:await fk\(o\.id,e,r\)/);
    assert.match(source, /codexLinuxRankBrowserBackends/);
    assert.match(source, /O\$\.platform\(\)!=="linux"/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Brave Origin patcher upgrades the Electron 42 core-patched profile roots", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-brave-origin-electron42-client-"));
  try {
    const chromePlugin = path.join(workspace, "chrome");
    const scriptsDir = path.join(chromePlugin, "scripts");

    writeFakeChromePlugin(chromePlugin);
    fs.writeFileSync(path.join(scriptsDir, "browser-client.mjs"), electron42CorePatchedBrowserClientFixture());

    run("node", [path.join(repoRoot, "scripts", "lib", "patch-chrome-plugin.js"), chromePlugin]);
    run("node", [path.join(repoRoot, "linux-features", FEATURE_ID, "patch-chrome-plugin.js"), chromePlugin]);

    const source = fs.readFileSync(path.join(scriptsDir, "browser-client.mjs"), "utf8");
    assert.match(source, /"\.config","BraveSoftware","Brave-Origin-Nightly"/);
    assert.match(source, /"\.config","google-chrome-beta"/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Brave Origin patcher upgrades current Electron 42 core-patched profile roots", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-brave-origin-current-electron42-client-"));
  try {
    const chromePlugin = path.join(workspace, "chrome");
    const scriptsDir = path.join(chromePlugin, "scripts");

    writeFakeChromePlugin(chromePlugin);
    fs.writeFileSync(path.join(scriptsDir, "browser-client.mjs"), currentElectron42CorePatchedBrowserClientFixture());

    run("node", [path.join(repoRoot, "scripts", "lib", "patch-chrome-plugin.js"), chromePlugin]);
    run("node", [path.join(repoRoot, "linux-features", FEATURE_ID, "patch-chrome-plugin.js"), chromePlugin]);

    const source = fs.readFileSync(path.join(scriptsDir, "browser-client.mjs"), "utf8");
    assert.match(source, /"\.config","BraveSoftware","Brave-Origin-Nightly"/);
    assert.match(source, /"\.config","BraveSoftware","Brave-Browser"/);
    assert.match(source, /"\.config","google-chrome-beta"/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Brave Origin stage hook fails closed when the Chrome plugin is missing", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-brave-origin-missing-plugin-"));
  try {
    const installDir = path.join(workspace, "install");
    const workDir = path.join(workspace, "work");
    const featuresConfig = path.join(workspace, "features.json");

    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(featuresConfig, JSON.stringify({ enabled: [FEATURE_ID] }, null, 2));

    const result = spawnSync("bash", [
      "-lc",
      [
        "source \"$LINUX_FEATURES_RUNNER\"",
        "info(){ echo \"$*\" >&2; }",
        "warn(){ echo \"$*\" >&2; }",
        "SCRIPT_DIR=\"$REPO_ROOT\"",
        "INSTALL_DIR=\"$INSTALL_DIR\"",
        "WORK_DIR=\"$WORK_DIR\"",
        "ARCH=x86_64",
        "run_linux_feature_stage_hooks",
      ].join("\n"),
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_LINUX_FEATURES_CONFIG: featuresConfig,
        LINUX_FEATURES_RUNNER: path.join(repoRoot, "scripts", "lib", "linux-features.sh"),
        REPO_ROOT: repoRoot,
        INSTALL_DIR: installDir,
        WORK_DIR: workDir,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Chrome plugin not found; Brave Origin browser control cannot be staged/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Brave Origin plugin patcher fails closed on unresolved upstream drift", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-brave-origin-drift-"));
  try {
    const chromePlugin = path.join(workspace, "chrome");
    writeFakeChromePlugin(chromePlugin);
    fs.writeFileSync(
      path.join(chromePlugin, "scripts", "installed-browsers.js"),
      "const KNOWN_BROWSERS = [];\n",
    );

    const result = spawnSync("node", [
      path.join(repoRoot, "linux-features", FEATURE_ID, "patch-chrome-plugin.js"),
      chromePlugin,
    ], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /installed-browsers\.js missing patch target for Brave Origin browser inventory/);
    assert.match(result.stderr, /Brave Origin browser-control patch failed closed/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
