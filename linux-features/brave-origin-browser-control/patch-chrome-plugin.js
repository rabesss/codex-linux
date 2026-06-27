#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const failures = [];

function recordFailure(message) {
  failures.push(message);
  process.stderr.write(`ERROR: ${message}\n`);
}

function sourceIncludesAny(source, texts) {
  return (Array.isArray(texts) ? texts : [texts]).some(
    (text) => typeof text === "string" && text.length > 0 && source.includes(text),
  );
}

function patchFile(filePath, patches) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    recordFailure(`Could not read ${filePath}: ${error.message}`);
    return;
  }

  let changed = false;
  for (const { label, oldText, newText, alreadyText = newText } of patches) {
    if (source.includes(newText) || sourceIncludesAny(source, alreadyText)) {
      console.log(`${path.basename(filePath)} already patched: ${label}`);
      continue;
    }
    if (!source.includes(oldText)) {
      recordFailure(`${path.basename(filePath)} missing patch target for ${label}`);
      continue;
    }
    source = source.replace(oldText, newText);
    changed = true;
    console.log(`Patched ${path.basename(filePath)}: ${label}`);
  }

  if (changed) {
    fs.writeFileSync(filePath, source, "utf8");
  }
}

function patchFileFirstMatch(filePath, { label, oldTexts, newText, alreadyText = newText }) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    recordFailure(`Could not read ${filePath}: ${error.message}`);
    return;
  }

  if ((typeof newText === "string" && source.includes(newText)) || sourceIncludesAny(source, alreadyText)) {
    console.log(`${path.basename(filePath)} already patched: ${label}`);
    return;
  }

  const match = oldTexts
    .map((candidate) => typeof candidate === "string" ? { oldText: candidate, newText } : candidate)
    .find((candidate) => source.includes(candidate.oldText));
  if (!match) {
    recordFailure(`${path.basename(filePath)} missing patch target for ${label}`);
    return;
  }

  fs.writeFileSync(filePath, source.replace(match.oldText, match.newText ?? newText), "utf8");
  console.log(`Patched ${path.basename(filePath)}: ${label}`);
}

const pluginDir = process.argv[2];
if (!pluginDir) {
  throw new Error("Usage: patch-chrome-plugin.js /path/to/chrome/plugin");
}

const scriptsDir = path.resolve(pluginDir, "scripts");

const nativeHostManifestFallback = `  if (process.platform === "linux") {
    const manifestPaths = [
      path.join(
        os.homedir(),
        ".config",
        "google-chrome",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
      path.join(
        os.homedir(),
        ".config",
        "BraveSoftware",
        "Brave-Origin-Nightly",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
      path.join(
        os.homedir(),
        ".config",
        "BraveSoftware",
        "Brave-Browser",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
      path.join(
        os.homedir(),
        ".config",
        "chromium",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
    ];

    return {
      manifestPath:
        manifestPaths.find((candidate) => fs.existsSync(candidate)) ||
        manifestPaths[0],
      registryKey: null,
      registryManifestPath: null,
      registryKeyExists: null,
    };
  }`;

const nativeHostManifestFallbackWithoutBraveOrigin = nativeHostManifestFallback.replace(
  `      path.join(
        os.homedir(),
        ".config",
        "BraveSoftware",
        "Brave-Origin-Nightly",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
`,
  "",
);

const extensionAwareUserDataFallback = `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
  const linuxChromiumUserDataDirectory = path.join(os.homedir(), ".config", "chromium");
  const linuxBraveOriginUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Origin-Nightly",
  );
  const linuxBraveUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Browser",
  );
  const linuxUserDataCandidates = [
    linuxBraveOriginUserDataDirectory,
    linuxBraveUserDataDirectory,
    linuxChromeUserDataDirectory,
    linuxChromiumUserDataDirectory,
  ].filter((candidate) => fs.existsSync(candidate));
  const linuxCandidateWithInstalledExtension = linuxUserDataCandidates.find(
    (candidate) => {
      try {
        const extensionId = loadRemoteChromeExtensionId();
        return findLatestChromeProfile(candidate) != null &&
          fs.existsSync(
            path.join(
              candidate,
              resolveChromeProfileDirectory(candidate),
              "Extensions",
              extensionId,
            ),
          );
      } catch {
        return false;
      }
    },
  );
  if (linuxCandidateWithInstalledExtension) {
    return linuxCandidateWithInstalledExtension;
  }

  if (linuxUserDataCandidates.length > 0) return linuxUserDataCandidates[0];

  return linuxChromeUserDataDirectory;`;

const extensionAwareUserDataFallbackWithoutBraveOrigin = extensionAwareUserDataFallback
  .replace(`  const linuxBraveOriginUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Origin-Nightly",
  );
`, "")
  .replace("    linuxBraveOriginUserDataDirectory,\n", "");

const defaultBrowserUserDataFallback = `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
  const linuxChromiumUserDataDirectory = path.join(os.homedir(), ".config", "chromium");
  const linuxBraveOriginUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Origin-Nightly",
  );
  const linuxBraveUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Browser",
  );
  const defaultBrowser = runCommand(["xdg-settings", "get", "default-web-browser"]);
  if (
    defaultBrowser === "brave-origin-nightly.desktop" &&
    fs.existsSync(linuxBraveOriginUserDataDirectory)
  ) {
    return linuxBraveOriginUserDataDirectory;
  }
  if (
    defaultBrowser === "brave-browser.desktop" &&
    fs.existsSync(linuxBraveUserDataDirectory)
  ) {
    return linuxBraveUserDataDirectory;
  }
  if (
    ["chromium.desktop", "chromium-browser.desktop"].includes(defaultBrowser) &&
    fs.existsSync(linuxChromiumUserDataDirectory)
  ) {
    return linuxChromiumUserDataDirectory;
  }

  if (fs.existsSync(linuxBraveOriginUserDataDirectory)) return linuxBraveOriginUserDataDirectory;
  if (fs.existsSync(linuxBraveUserDataDirectory)) return linuxBraveUserDataDirectory;
  if (fs.existsSync(linuxChromeUserDataDirectory)) return linuxChromeUserDataDirectory;
  if (fs.existsSync(linuxChromiumUserDataDirectory)) return linuxChromiumUserDataDirectory;

  return linuxChromeUserDataDirectory;`;

const defaultBrowserUserDataFallbackWithoutBraveOrigin = defaultBrowserUserDataFallback
  .replace(`  const linuxBraveOriginUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Origin-Nightly",
  );
`, "")
  .replace(`  if (
    defaultBrowser === "brave-origin-nightly.desktop" &&
    fs.existsSync(linuxBraveOriginUserDataDirectory)
  ) {
    return linuxBraveOriginUserDataDirectory;
  }
`, "")
  .replace("  if (fs.existsSync(linuxBraveOriginUserDataDirectory)) return linuxBraveOriginUserDataDirectory;\n", "");

patchFileFirstMatch(path.join(scriptsDir, "installManifest.mjs"), {
  label: "Brave Origin native host manifest location",
  oldTexts: [
    'linux:[".config/google-chrome/NativeMessagingHosts",".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",".config/chromium/NativeMessagingHosts"]',
    'linux:[".config/google-chrome/NativeMessagingHosts"]',
  ],
  newText:
    'linux:[".config/google-chrome/NativeMessagingHosts",".config/BraveSoftware/Brave-Origin-Nightly/NativeMessagingHosts",".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",".config/chromium/NativeMessagingHosts"]',
  alreadyText: "Brave-Origin-Nightly/NativeMessagingHosts",
});

patchFile(path.join(scriptsDir, "check-native-host-manifest.js"), [
  {
    label: "Brave Origin native host manifest fallback",
    oldText: nativeHostManifestFallbackWithoutBraveOrigin,
    newText: nativeHostManifestFallback,
    alreadyText: '"Brave-Origin-Nightly"',
  },
]);

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Brave Origin browser profile roots",
  oldTexts: [
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>WF()==="linux"?[GF(VF(),".config","BraveSoftware","Brave-Browser"),GF(VF(),".config","google-chrome"),GF(VF(),".config","chromium")]:[Tc]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>WF()==="linux"?[GF(VF(),".config","BraveSoftware","Brave-Origin-Nightly"),GF(VF(),".config","BraveSoftware","Brave-Browser"),GF(VF(),".config","google-chrome"),GF(VF(),".config","chromium")]:[Tc]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>rO()==="linux"?[eO(tO(),".config","BraveSoftware","Brave-Browser"),eO(tO(),".config","google-chrome"),eO(tO(),".config","chromium")]:[Ic]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>rO()==="linux"?[eO(tO(),".config","BraveSoftware","Brave-Origin-Nightly"),eO(tO(),".config","BraveSoftware","Brave-Browser"),eO(tO(),".config","google-chrome"),eO(tO(),".config","chromium")]:[Ic]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>X5()==="linux"?[Y5(Z5(),".config","BraveSoftware","Brave-Browser"),Y5(Z5(),".config","google-chrome"),Y5(Z5(),".config","chromium")]:[hl]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>X5()==="linux"?[Y5(Z5(),".config","BraveSoftware","Brave-Origin-Nightly"),Y5(Z5(),".config","BraveSoftware","Brave-Browser"),Y5(Z5(),".config","google-chrome"),Y5(Z5(),".config","chromium")]:[hl]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>L9()==="linux"?[M9(F9(),".config","BraveSoftware","Brave-Browser"),M9(F9(),".config","google-chrome"),M9(F9(),".config","chromium")]:[kl]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>L9()==="linux"?[M9(F9(),".config","BraveSoftware","Brave-Origin-Nightly"),M9(F9(),".config","BraveSoftware","Brave-Browser"),M9(F9(),".config","google-chrome"),M9(F9(),".config","chromium")]:[kl]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>Mj()==="linux"?[Nj(Oj(),".config","BraveSoftware","Brave-Browser"),Nj(Oj(),".config","google-chrome"),Nj(Oj(),".config","chromium")]:[$c]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>Mj()==="linux"?[Nj(Oj(),".config","BraveSoftware","Brave-Origin-Nightly"),Nj(Oj(),".config","BraveSoftware","Brave-Browser"),Nj(Oj(),".config","google-chrome"),Nj(Oj(),".config","chromium")]:[$c]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>e$()==="linux"?[Xq(Qq(),".config","BraveSoftware","Brave-Browser"),Xq(Qq(),".config","google-chrome"),Xq(Qq(),".config","chromium")]:[ld]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>e$()==="linux"?[Xq(Qq(),".config","BraveSoftware","Brave-Origin-Nightly"),Xq(Qq(),".config","BraveSoftware","Brave-Browser"),Xq(Qq(),".config","google-chrome"),Xq(Qq(),".config","chromium")]:[ld]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>f$()==="linux"?[d$(p$(),".config","BraveSoftware","Brave-Browser"),d$(p$(),".config","google-chrome"),d$(p$(),".config","chromium")]:[cd]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>f$()==="linux"?[d$(p$(),".config","BraveSoftware","Brave-Origin-Nightly"),d$(p$(),".config","BraveSoftware","Brave-Browser"),d$(p$(),".config","google-chrome"),d$(p$(),".config","chromium")]:[cd]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>S$()==="linux"?[w$(x$(),".config","BraveSoftware","Brave-Browser"),w$(x$(),".config","google-chrome"),w$(x$(),".config","chromium")]:[md]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>S$()==="linux"?[w$(x$(),".config","BraveSoftware","Brave-Origin-Nightly"),w$(x$(),".config","BraveSoftware","Brave-Browser"),w$(x$(),".config","google-chrome"),w$(x$(),".config","chromium")]:[md]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>H7()==="linux"?[z7(W7(),".config","BraveSoftware","Brave-Browser"),z7(W7(),".config","google-chrome"),z7(W7(),".config","google-chrome-beta"),z7(W7(),".config","google-chrome-unstable"),z7(W7(),".config","chromium")]:[Rd]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>H7()==="linux"?[z7(W7(),".config","BraveSoftware","Brave-Origin-Nightly"),z7(W7(),".config","BraveSoftware","Brave-Browser"),z7(W7(),".config","google-chrome"),z7(W7(),".config","google-chrome-beta"),z7(W7(),".config","google-chrome-unstable"),z7(W7(),".config","chromium")]:[Rd]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>fH()==="linux"?[dH(pH(),".config","BraveSoftware","Brave-Browser"),dH(pH(),".config","google-chrome"),dH(pH(),".config","google-chrome-beta"),dH(pH(),".config","google-chrome-unstable"),dH(pH(),".config","chromium")]:[Xd]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>fH()==="linux"?[dH(pH(),".config","BraveSoftware","Brave-Origin-Nightly"),dH(pH(),".config","BraveSoftware","Brave-Browser"),dH(pH(),".config","google-chrome"),dH(pH(),".config","google-chrome-beta"),dH(pH(),".config","google-chrome-unstable"),dH(pH(),".config","chromium")]:[Xd]`,
    },
  ],
  alreadyText: '".config","BraveSoftware","Brave-Origin-Nightly"',
});

patchFileFirstMatch(path.join(scriptsDir, "installed-browsers.js"), {
  label: "Brave Origin browser inventory",
  oldTexts: [
    {
      oldText: `  {
    name: "Brave",
    bundleIds: ["com.brave.Browser"],
    appNames: ["Brave Browser.app"],
    commands: ["brave-browser", "brave"],
    windowsExecutable: "chrome.exe",
  },`,
      newText: `  {
    name: "Brave Origin Nightly",
    bundleIds: ["com.brave.Browser.nightly"],
    appNames: ["Brave Origin Nightly.app"],
    commands: ["brave-origin-nightly"],
    windowsExecutable: "chrome.exe",
  },
  {
    name: "Brave",
    bundleIds: ["com.brave.Browser"],
    appNames: ["Brave Browser.app"],
    commands: ["brave-browser", "brave"],
    windowsExecutable: "chrome.exe",
  },`,
    },
    {
      oldText: `  {
    name: "Brave Browser",
    bundleIds: ["com.brave.Browser"],
    appNames: ["Brave Browser.app"],
    commands: ["brave-browser", "brave"],
    windowsExecutable: "brave.exe",
  },`,
      newText: `  {
    name: "Brave Origin Nightly",
    bundleIds: ["com.brave.Browser.nightly"],
    appNames: ["Brave Origin Nightly.app"],
    commands: ["brave-origin-nightly"],
    windowsExecutable: "brave.exe",
  },
  {
    name: "Brave Browser",
    bundleIds: ["com.brave.Browser"],
    appNames: ["Brave Browser.app"],
    commands: ["brave-browser", "brave"],
    windowsExecutable: "brave.exe",
  },`,
    },
  ],
  alreadyText: '"Brave Origin Nightly"',
});

patchFile(path.join(scriptsDir, "chrome-is-running.js"), [
  {
    label: "Brave Origin running-process detection",
    oldText: `  linux: new Set(["chrome", "google-chrome", "brave", "brave-browser", "chromium", "chromium-browser"]),`,
    newText: `  linux: new Set(["chrome", "google-chrome", "brave-origin-nightly", "brave", "brave-browser", "chromium", "chromium-browser"]),`,
    alreadyText: "brave-origin-nightly",
  },
]);

patchFileFirstMatch(path.join(scriptsDir, "check-extension-installed.js"), {
  label: "Brave Origin extension-aware browser profile fallback",
  oldTexts: [extensionAwareUserDataFallbackWithoutBraveOrigin],
  newText: extensionAwareUserDataFallback,
  alreadyText: "linuxBraveOriginUserDataDirectory",
});

for (const scriptName of ["check-extension-installed.js", "open-chrome-window.js"]) {
  patchFile(path.join(scriptsDir, scriptName), [
    {
      label: "Brave Origin running browser command detection",
      oldText: `  return [
    "brave",
    "brave-browser",`,
      newText: `  return [
    "brave-origin-nightly",
    "brave",
    "brave-browser",`,
      alreadyText: '"brave-origin-nightly"',
    },
    {
      label: "Brave Origin running browser default profile",
      oldText: `  if (["brave", "brave-browser"].includes(commandName)) {
    return path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser");
  }`,
      newText: `  if (commandName === "brave-origin-nightly") {
    return path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Origin-Nightly");
  }
  if (["brave", "brave-browser"].includes(commandName)) {
    return path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser");
  }`,
      alreadyText: 'commandName === "brave-origin-nightly"',
    },
  ]);
}

patchFileFirstMatch(path.join(scriptsDir, "open-chrome-window.js"), {
  label: "Brave Origin default-browser profile fallback",
  oldTexts: [defaultBrowserUserDataFallbackWithoutBraveOrigin],
  newText: defaultBrowserUserDataFallback,
  alreadyText: "linuxBraveOriginUserDataDirectory",
});

patchFile(path.join(scriptsDir, "open-chrome-window.js"), [
  {
    label: "Brave Origin browser window command",
    oldText: `  if (linuxExecutableOverride) {
    linuxCommand = linuxExecutableOverride;
  } else if (
    linuxUserDataDirectory.includes(
      path.join(".config", "BraveSoftware", "Brave-Browser"),
    )
  ) {
    linuxCommand = commandPath("brave-browser") || commandPath("brave") || "brave-browser";
  } else if (linuxUserDataDirectory.includes(path.join(".config", "chromium"))) {
    linuxCommand = commandPath("chromium") || commandPath("chromium-browser") || "chromium";
  }`,
    newText: `  if (linuxExecutableOverride) {
    linuxCommand = linuxExecutableOverride;
  } else if (
    linuxUserDataDirectory.includes(
      path.join(".config", "BraveSoftware", "Brave-Origin-Nightly"),
    )
  ) {
    linuxCommand = commandPath("brave-origin-nightly") || "brave-origin-nightly";
  } else if (
    linuxUserDataDirectory.includes(
      path.join(".config", "BraveSoftware", "Brave-Browser"),
    )
  ) {
    linuxCommand = commandPath("brave-browser") || commandPath("brave") || "brave-browser";
  } else if (linuxUserDataDirectory.includes(path.join(".config", "chromium"))) {
    linuxCommand = commandPath("chromium") || commandPath("chromium-browser") || "chromium";
  }`,
    alreadyText: 'commandPath("brave-origin-nightly")',
  },
]);

if (failures.length > 0) {
  process.stderr.write(
    `ERROR: Brave Origin browser-control patch failed closed with ${failures.length} unresolved target(s)\n`,
  );
  process.exitCode = 1;
}
