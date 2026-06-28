"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  TRAY_GUARD_LOOKAHEAD,
  escapeRegExp,
  findCallBlock,
  findMatchingBrace,
  inferModuleAlias,
  requireName,
} = require("./shared.js");

// Main-process patches adapt Electron shell behavior: windows, tray, menu,
// single-instance handling, file manager integration, and packaged runtime glue.
function applyLinuxFileManagerPatch(currentSource) {
  const block = findCallBlock(currentSource, "id:`fileManager`");
  if (block == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  if (block.text.includes("linux:{")) {
    return currentSource;
  }

  const electronVar = requireName(currentSource, "electron");
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (electronVar == null || fsVar == null || pathVar == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const insertionPoint = block.text.lastIndexOf("}});");
  if (insertionPoint === -1) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const linuxFileManager =
    `,linux:{label:\`File Manager\`,icon:\`apps/file-explorer.png\`,detect:()=>\`linux-file-manager\`,args:e=>[e],open:async({path:e})=>{let __codexResolved=e;for(;;){if((0,${fsVar}.existsSync)(__codexResolved))break;let __codexParent=(0,${pathVar}.dirname)(__codexResolved);if(__codexParent===__codexResolved){__codexResolved=null;break}__codexResolved=__codexParent}let __codexOpenTarget=__codexResolved??e;if((0,${fsVar}.existsSync)(__codexOpenTarget)&&(0,${fsVar}.statSync)(__codexOpenTarget).isFile())__codexOpenTarget=(0,${pathVar}.dirname)(__codexOpenTarget);let __codexError=await ${electronVar}.shell.openPath(__codexOpenTarget);if(__codexError)throw Error(__codexError)}}`;

  const patchedBlock =
    block.text.slice(0, insertionPoint + 1) +
    linuxFileManager +
    block.text.slice(insertionPoint + 1);
  const patchedSource =
    currentSource.slice(0, block.start) + patchedBlock + currentSource.slice(block.end);

  const patchedBlockCheck = patchedSource.slice(block.start, block.start + patchedBlock.length);
  if (
    !patchedBlockCheck.includes("linux:{label:`File Manager`") ||
    !patchedBlockCheck.includes("detect:()=>`linux-file-manager`") ||
    !patchedBlockCheck.includes(`${electronVar}.shell.openPath(__codexOpenTarget)`)
  ) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  return patchedSource;
}

function applyLinuxWindowOptionsPatch(currentSource, iconAsset) {
  let patchedSource = currentSource;

  if (iconAsset != null) {
    const windowOptionsNeedle = "...process.platform===`win32`?{autoHideMenuBar:!0}:{},";
    const currentLinuxAutoHideMenuBarNeedle =
      "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},";
    const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
    const iconPathNeedle = `icon:${iconPathExpression}`;
    const setIconNeedle = `setIcon(${iconPathExpression})`;
    const readyToShowSetIconInsertionPattern = /[A-Za-z_$][\w$]*\.once\(`ready-to-show`,\(\)=>\{/;
    const legacyLinuxSystemTitlebarNeedle =
      `...process.platform===\`win32\`||process.platform===\`linux\`?{autoHideMenuBar:!0,...process.platform===\`linux\`?{${iconPathNeedle}}:{}}:{},`;
    const windowOptionsReplacement =
      `...process.platform===\`win32\`?{autoHideMenuBar:!0}:process.platform===\`linux\`?{${iconPathNeedle}}:{},`;

    if (patchedSource.includes(legacyLinuxSystemTitlebarNeedle)) {
      patchedSource = patchedSource.split(legacyLinuxSystemTitlebarNeedle).join(windowOptionsReplacement);
    }

    if (patchedSource.includes(windowOptionsNeedle)) {
      patchedSource = patchedSource.split(windowOptionsNeedle).join(windowOptionsReplacement);
    } else if (patchedSource.includes(currentLinuxAutoHideMenuBarNeedle)) {
      patchedSource = patchedSource.split(currentLinuxAutoHideMenuBarNeedle).join(windowOptionsReplacement);
    } else if (
      patchedSource === currentSource &&
      !patchedSource.includes(iconPathNeedle) &&
      !patchedSource.includes(setIconNeedle) &&
      !readyToShowSetIconInsertionPattern.test(patchedSource)
    ) {
      console.warn("WARN: Could not find BrowserWindow autoHideMenuBar snippet — skipping window options patch");
    }
  }

  return applyDefinedBrowserWindowOptionsPatch(patchedSource);
}

function applyDefinedBrowserWindowOptionsPatch(currentSource) {
  const browserWindowOptionsRegex =
    /show:([A-Za-z_$][\w$]*),parent:([A-Za-z_$][\w$]*),focusable:([A-Za-z_$][\w$]*),(\.\.\.process\.platform===`win32`\?\{autoHideMenuBar:!0\}:process\.platform===`linux`\?\{icon:process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\/[^`]+`\}:\{\},)backgroundMaterial:([A-Za-z_$][\w$]*)\?\?void 0,\.\.\.([A-Za-z_$][\w$]*),minWidth:([A-Za-z_$][\w$]*)\?\.width,minHeight:\7\?\.height,webPreferences:([A-Za-z_$][\w$]*)/g;

  return currentSource.replace(
    browserWindowOptionsRegex,
    (
      _match,
      showAlias,
      parentAlias,
      focusableAlias,
      platformOptions,
      backgroundMaterialAlias,
      appearanceOptionsAlias,
      minimumSizeAlias,
      webPreferencesAlias,
    ) =>
      `show:${showAlias},...${parentAlias}==null?{}:{parent:${parentAlias}},...${focusableAlias}==null?{}:{focusable:${focusableAlias}},${platformOptions}...${backgroundMaterialAlias}==null?{}:{backgroundMaterial:${backgroundMaterialAlias}},...${appearanceOptionsAlias},...${minimumSizeAlias}==null?{}:{minWidth:${minimumSizeAlias}.width,minHeight:${minimumSizeAlias}.height},webPreferences:${webPreferencesAlias}`,
  );
}

function applyLinuxMenuPatch(currentSource) {
  const menuRegex = /process\.platform===`win32`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(menuRegex, (match, windowVar, offset) => {
    const linuxPatch = `process.platform===\`linux\`&&${windowVar}.setMenuBarVisibility(!1),`;
    if (currentSource.slice(Math.max(0, offset - linuxPatch.length), offset) === linuxPatch) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  if (!patchedAny && !currentSource.includes("setMenuBarVisibility(!1)")) {
    const hasWindowsRemoveMenu = /process\.platform===`win32`&&[A-Za-z_$][\w$]*\.removeMenu\(\),/.test(currentSource);
    if (hasWindowsRemoveMenu) {
      console.warn("WARN: Could not find window menu visibility snippet — skipping menu patch");
    }
  }

  return patchedSource;
}

function applyLinuxSetIconPatch(currentSource, iconAsset) {
  if (iconAsset == null) {
    return currentSource;
  }

  const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
  const readyRegex = /([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(readyRegex, (match, windowVar, offset) => {
    const linuxPatch = `process.platform===\`linux\`&&${windowVar}.setIcon(${iconPathExpression}),`;
    if (currentSource.slice(Math.max(0, offset - linuxPatch.length), offset) === linuxPatch) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  if (patchedAny) {
    return patchedSource;
  }

  if (currentSource.includes(`setIcon(${iconPathExpression})`)) {
    return currentSource;
  }

  console.warn("WARN: Could not find window setIcon insertion point — skipping setIcon patch");
  return currentSource;
}

function applyLinuxReadyToShowWindowStatePatch(currentSource) {
  const alreadyPatchedRegex =
    /[A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\.once\(`ready-to-show`,\(\)=>\{[A-Za-z_$][\w$]*\.isDestroyed\(\)\|\|[A-Za-z_$][\w$]*\.maximize\(\)\}\)/;
  if (alreadyPatchedRegex.test(currentSource)) {
    return currentSource;
  }

  const readyToShowMaximizeRegex =
    /([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{\1\.isDestroyed\(\)\|\|\1\.maximize\(\)\}\)/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(readyToShowMaximizeRegex, (_match, windowVar, offset, source) => {
    const prefix = source.slice(Math.max(0, offset - 120), offset);
    const maximizedStateMatch = prefix.match(/([A-Za-z_$][\w$]*)&&process\.platform===`linux`&&[A-Za-z_$][\w$]*\.setIcon\(/);
    const maximizedStateVar = maximizedStateMatch?.[1] ?? "false";
    patchedAny = true;
    return `${maximizedStateVar}&&${windowVar}.once(\`ready-to-show\`,()=>{${windowVar}.isDestroyed()||${windowVar}.maximize()})`;
  });

  if (patchedAny) {
    return patchedSource;
  }

  if (currentSource.includes("ready-to-show") && currentSource.includes(".maximize()")) {
    console.warn("WARN: Could not find ready-to-show maximize hook — skipping Linux window-state patch");
  }

  return currentSource;
}

function applyLinuxOpaqueBackgroundPatch(currentSource) {
  if (
    currentSource.includes("===`linux`&&!OM(") ||
    /===`linux`&&![A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\?\{backgroundColor:[^{}]+,backgroundMaterial:null\}/.test(currentSource)
  ) {
    return currentSource;
  }

  const colorConstRegex =
    /([A-Za-z_$][\w$]*)=`#00000000`,([A-Za-z_$][\w$]*)=`#000000`,([A-Za-z_$][\w$]*)=`#f9f9f9`/;
  const colorMatch = currentSource.match(colorConstRegex);

  if (!colorMatch) {
    console.warn(
      "WARN: Could not find color constants (#00000000, #000000, #f9f9f9) — skipping background patch",
    );
    return currentSource;
  }

  const [, transparentVar, darkVar, lightVar] = colorMatch;

  const opaqueSurfaceFuncRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowSurfaceEnabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\3\?\{[^{}]+\}:\1===`win32`&&!([A-Za-z_$][\w$]*)\(\2\)\?/;
  const opaqueSurfaceFuncMatch = currentSource.match(opaqueSurfaceFuncRegex);
  if (opaqueSurfaceFuncMatch != null) {
    const [, platformParam, appearanceParam, , darkColorsParam, transparentAppearancePredicate] =
      opaqueSurfaceFuncMatch;
    const win32Needle =
      `:${platformParam}===\`win32\`&&!${transparentAppearancePredicate}(${appearanceParam})?`;
    const linuxBgPrefix =
      `:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:`;
    if (currentSource.includes(linuxBgPrefix)) {
      return currentSource;
    }
    if (currentSource.includes(win32Needle)) {
      return currentSource.replace(win32Needle, `${linuxBgPrefix}${win32Needle.slice(1)}`);
    }
  }

  const currentFuncParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaque(?:WindowSurface|Windows)Enabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\3&&!([A-Za-z_$][\w$]*)\(\2\)&&\(\1===`darwin`\|\|\1===`win32`\)\?/;
  const currentFuncMatch = currentSource.match(currentFuncParamRegex);
  if (currentFuncMatch != null) {
    const [, platformParam, appearanceParam, , darkColorsParam, transparentAppearancePredicate] =
      currentFuncMatch;
    const win32Needle =
      `:${platformParam}===\`win32\`&&!${transparentAppearancePredicate}(${appearanceParam})?`;
    const linuxBgPrefix =
      `:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:`;

    if (currentSource.includes(linuxBgPrefix)) {
      return currentSource;
    }
    if (currentSource.includes(win32Needle)) {
      return currentSource.replace(win32Needle, `${linuxBgPrefix}${win32Needle.slice(1)}`);
    }

    console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
    return currentSource;
  }

  const funcParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaque(?:WindowSurface|Windows)Enabled:[A-Za-z_$][\w$]*,prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\1===`win32`&&!([A-Za-z_$][\w$]*)\(\2\)/;
  const funcMatch = currentSource.match(funcParamRegex);

  if (funcMatch == null) {
    console.warn("WARN: Could not find BrowserWindow background function signature — skipping background patch");
    return currentSource;
  }

  const [, platformParam, appearanceParam, darkColorsParam, transparentAppearancePredicate] =
    funcMatch;
  const bgNeedle =
    `backgroundMaterial:\`mica\`}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const oldLinuxBgPatch =
    `backgroundMaterial:\`mica\`}:process.platform===\`linux\`?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const bgReplacement =
    `backgroundMaterial:\`mica\`}:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;

  if (currentSource.includes(bgNeedle)) {
    return currentSource.replace(bgNeedle, bgReplacement);
  }
  if (currentSource.includes(oldLinuxBgPatch)) {
    return currentSource.replace(oldLinuxBgPatch, bgReplacement);
  }

  console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
  return currentSource;
}

function findNamedFunctionBody(source, functionName) {
  const functionMatch = source.match(
    new RegExp(`(?:async\\s+)?function\\s+${escapeRegExp(functionName)}\\([^)]*\\)\\{`),
  );
  if (functionMatch == null) {
    return null;
  }

  const openIndex = functionMatch.index + functionMatch[0].length - 1;
  const closeIndex = findMatchingBrace(source, openIndex);
  return closeIndex === -1 ? null : source.slice(openIndex, closeIndex + 1);
}

function isTrayFactoryFunction(source, functionName) {
  const body = findNamedFunctionBody(source, functionName);
  return body != null && /new [A-Za-z_$][\w$]*\.Tray\(/.test(body);
}

function findDynamicTraySetup(source) {
  const setupRegex =
    /let ([A-Za-z_$][\w$]*)=async\(\)=>\{[A-Za-z_$][\w$]*=!0;try\{await ([A-Za-z_$][\w$]*)\(\{/g;
  let match;
  while ((match = setupRegex.exec(source)) != null) {
    const [, setupFn, factoryFn] = match;
    if (isTrayFactoryFunction(source, factoryFn)) {
      return { setupFn, index: match.index };
    }
  }
  return null;
}

function findDynamicTrayStartupCall(source, setupFn, startIndex) {
  const startupRegex = new RegExp(`([A-Za-z_$][\\w$]*)&&${escapeRegExp(setupFn)}\\(\\);`, "g");
  startupRegex.lastIndex = startIndex;
  return startupRegex.exec(source);
}

function applyLinuxQuitGuardPatch(currentSource) {
  let patchedSource = currentSource;

  const quitGuardNeedle = "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`);";
  const legacyQuitGuardSuffix =
    "let codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";
  const quitGuardSuffix =
    "let codexLinuxQuitInProgress=!1,codexLinuxExplicitQuitApproved=!1,codexLinuxExplicitQuitDrainTimeoutMs=3e3,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxPrepareForExplicitQuit=()=>{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress()},codexLinuxShouldBypassQuitPrompt=()=>codexLinuxExplicitQuitApproved===!0,codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";
  const quitGuardPatch = `${quitGuardNeedle}${quitGuardSuffix}`;

  if (patchedSource.includes("codexLinuxExplicitQuitApproved=!1")) {
    return patchedSource;
  }

  if (patchedSource.includes(legacyQuitGuardSuffix)) {
    return patchedSource.replace(legacyQuitGuardSuffix, quitGuardSuffix);
  }

  if (patchedSource.includes(quitGuardNeedle)) {
    return patchedSource.replace(quitGuardNeedle, quitGuardPatch);
  }

  const splitQuitGuardNeedle =
    /let ([A-Za-z_$][\w$]*)=require\(`electron`\);(?:\1=[^;]+;)?let ([A-Za-z_$][\w$]*)=require\(`node:path`\);(?:\2=[^;]+;)?let ([A-Za-z_$][\w$]*)=require\(`node:fs`\);(?:\3=[^;]+;)?/;
  const splitQuitGuardMatch = patchedSource.match(splitQuitGuardNeedle);
  if (splitQuitGuardMatch != null) {
    const matchedPrefix = splitQuitGuardMatch[0];
    return patchedSource.replace(matchedPrefix, `${matchedPrefix}${quitGuardSuffix}`);
  }

  if (patchedSource.includes("require(`electron`)")) {
    return `${quitGuardSuffix}${patchedSource}`;
  }

  if (patchedSource.includes("require(`electron`)") && patchedSource.includes("require(`node:path`)")) {
    console.warn("WARN: Could not find Linux quit guard insertion point — skipping explicit quit-state patch");
  }

  return patchedSource;
}

function linuxExplicitQuitExpression() {
  return "typeof codexLinuxPrepareForExplicitQuit===`function`?codexLinuxPrepareForExplicitQuit():typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),";
}

function applyLinuxWillQuitDrainTimeoutPatch(currentSource) {
  let patchedSource = currentSource;

  const explicitQuitDrainGuard =
    "process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())";
  const originalDrainSnippet =
    "Promise.all([...u.values()].map(e=>e.flush())).finally(()=>{d(),f.dispose(),n.app.quit()})";
  const patchedDrainSnippet =
    "(()=>{let codexLinuxFinalizeQuit=()=>{d(),f.dispose(),n.app.quit()},codexLinuxDrainPromise=Promise.all([...u.values()].map(e=>e.flush()));" +
    `if(${explicitQuitDrainGuard}){Promise.race([codexLinuxDrainPromise,new Promise(e=>setTimeout(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===\`number\`?codexLinuxExplicitQuitDrainTimeoutMs:3e3))]).finally(codexLinuxFinalizeQuit);return}` +
    "codexLinuxDrainPromise.finally(codexLinuxFinalizeQuit)})()";
  let patchedAny = false;

  if (patchedSource.includes(originalDrainSnippet)) {
    patchedAny = true;
    patchedSource = patchedSource.split(originalDrainSnippet).join(patchedDrainSnippet);
  }

  const drainRegex =
    /Promise\.all\(\[\.\.\.([A-Za-z_$][\w$]*)\.values\(\)\]\.map\(e=>e\.flush\(\)\)\)\.finally\(\(\)=>\{([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)\.dispose\(\),([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\)/g;
  patchedSource = patchedSource.replace(
    drainRegex,
    (_match, globalStatesVar, flushDisposeVar, disposablesVar, electronVar) => {
      patchedAny = true;
      return `(()=>{let codexLinuxFinalizeQuit=()=>{${flushDisposeVar}(),${disposablesVar}.dispose(),${electronVar}.app.quit()},codexLinuxDrainPromise=Promise.all([...${globalStatesVar}.values()].map(e=>e.flush()));if(${explicitQuitDrainGuard}){Promise.race([codexLinuxDrainPromise,new Promise(e=>setTimeout(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===\`number\`?codexLinuxExplicitQuitDrainTimeoutMs:3e3))]).finally(codexLinuxFinalizeQuit);return}codexLinuxDrainPromise.finally(codexLinuxFinalizeQuit)})()`;
    },
  );

  if (
    !patchedAny &&
    !patchedSource.includes("codexLinuxDrainPromise=Promise.all(") &&
    patchedSource.includes("n.app.on(`will-quit`,") &&
    patchedSource.includes(".map(e=>e.flush())")
  ) {
    console.warn("WARN: Could not find will-quit drain sequence — skipping Linux explicit quit drain timeout patch");
  }

  return patchedSource;
}

function applyLinuxExplicitQuitPromptBypassPatch(currentSource) {
  let patchedSource = currentSource;

  const promptBypassExpression =
    "(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt())||";
  const promptBypassGuard = `if(${promptBypassExpression}`;
  const quitMarkerExpression =
    "process.platform===`linux`&&typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),";
  const beforeQuitNeedle =
    "if(e||i.canQuitWithoutPrompt()||r||!s&&!c){g=!0,a.markAppQuitting();return}";
  const beforeQuitPatch =
    `if(${promptBypassExpression}e||i.canQuitWithoutPrompt()||r||!s&&!c){${quitMarkerExpression}g=!0,a.markAppQuitting();return}`;
  const beforeQuitRegex =
    /if\(([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\.canQuitWithoutPrompt\(\)\|\|([A-Za-z_$][\w$]*)\|\|!([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)=!0,([A-Za-z_$][\w$]*)\.markAppQuitting\(\);return\}/g;
  const patchedBeforeQuitWithoutMarkerRegex =
    /if\(\(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt\(\)\)\|\|([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\.canQuitWithoutPrompt\(\)\|\|([A-Za-z_$][\w$]*)\|\|!([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)=!0,([A-Za-z_$][\w$]*)\.markAppQuitting\(\);return\}/g;
  const acceptedPromptRegex =
    /([A-Za-z_$][\w$]*)\.markQuitApproved\(\),([A-Za-z_$][\w$]*)=!0,([A-Za-z_$][\w$]*)\.markAppQuitting\(\)/g;
  let patchedAny = false;

  if (patchedSource.includes(beforeQuitNeedle)) {
    patchedAny = true;
    patchedSource = patchedSource.split(beforeQuitNeedle).join(beforeQuitPatch);
  }

  patchedSource = patchedSource.replace(
    beforeQuitRegex,
    (_match, updateInstallVar, quitControllerVar, appQuittingVar, activeConversationVar, automationVar, quittingStateVar, appQuittingControllerVar) => {
      patchedAny = true;
      return `if(${promptBypassExpression}${updateInstallVar}||${quitControllerVar}.canQuitWithoutPrompt()||${appQuittingVar}||!${activeConversationVar}&&!${automationVar}){${quitMarkerExpression}${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting();return}`;
    },
  );
  patchedSource = patchedSource.replace(
    patchedBeforeQuitWithoutMarkerRegex,
    (_match, updateInstallVar, quitControllerVar, appQuittingVar, activeConversationVar, automationVar, quittingStateVar, appQuittingControllerVar) => {
      patchedAny = true;
      return `if(${promptBypassExpression}${updateInstallVar}||${quitControllerVar}.canQuitWithoutPrompt()||${appQuittingVar}||!${activeConversationVar}&&!${automationVar}){${quitMarkerExpression}${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting();return}`;
    },
  );
  patchedSource = patchedSource.replace(
    acceptedPromptRegex,
    (match, quitControllerVar, quittingStateVar, appQuittingControllerVar, offset, source) => {
      const prefix = source.slice(Math.max(0, offset - 120), offset);
      if (prefix.includes("codexLinuxMarkQuitInProgress()")) {
        return match;
      }
      patchedAny = true;
      return `${quitMarkerExpression}${quitControllerVar}.markQuitApproved(),${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting()`;
    },
  );

  if (
    !patchedAny &&
    !patchedSource.includes(promptBypassGuard) &&
    patchedSource.includes("showMessageBoxSync({type:`warning`,buttons:[`Quit`,`Cancel`]") &&
    patchedSource.includes(".canQuitWithoutPrompt()")
  ) {
    console.warn("WARN: Could not find before-quit confirmation guard — skipping Linux explicit quit prompt bypass patch");
  }

  return patchedSource;
}

function applyLinuxExplicitTrayQuitPatch(currentSource) {
  let patchedSource = currentSource;

  const quitMarkerExpression = linuxExplicitQuitExpression();

  const trayQuitNeedle = "{label:rB(this.appName),click:()=>{n.app.quit()}}";
  const trayQuitPatch =
    `{label:rB(this.appName),click:()=>{${quitMarkerExpression}n.app.quit()}}`;
  const patchedTrayQuitRegex =
    /\{label:[^{}]+,click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),[A-Za-z_$][\w$]*\.app\.quit\(\)\}\}/;
  const trayQuitRegex =
    /\{label:rB\(([^)]+)\),click:\(\)=>\{([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\}/g;
  const genericTrayQuitRegex =
    /\{label:([A-Za-z_$][\w$]*\(this\.appName\)),click:\(\)=>\{([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\}/g;
  let patchedAny = false;
  if (patchedSource.includes(trayQuitNeedle)) {
    patchedAny = true;
    patchedSource = patchedSource.split(trayQuitNeedle).join(trayQuitPatch);
  }
  patchedSource = patchedSource.replace(
    trayQuitRegex,
    (_match, appNameExpr, electronVar) => {
      patchedAny = true;
      return `{label:rB(${appNameExpr}),click:()=>{${quitMarkerExpression}${electronVar}.app.quit()}}`;
    },
  );
  patchedSource = patchedSource.replace(
    genericTrayQuitRegex,
    (_match, labelExpression, electronVar) => {
      patchedAny = true;
      return `{label:${labelExpression},click:()=>{${quitMarkerExpression}${electronVar}.app.quit()}}`;
    },
  );
  if (
    !patchedAny &&
    !patchedTrayQuitRegex.test(patchedSource) &&
    patchedSource.includes("getNativeTrayMenuItems(){") &&
    (patchedSource.includes("label:rB(") || patchedSource.includes("role:`quit`"))
  ) {
    console.warn("WARN: Could not find tray quit menu handler — skipping Linux explicit tray quit patch");
  }

  return patchedSource;
}

function applyLinuxExplicitIpcQuitPatch(currentSource) {
  let patchedSource = currentSource;

  const quitMarkerExpression = linuxExplicitQuitExpression();

  const quitAppNeedle = "if(o.type===`quit-app`){n.app.quit();return}";
  const quitAppPatch = `if(o.type===\`quit-app\`){${quitMarkerExpression}n.app.quit();return}`;
  const quitAppRegex =
    /if\(([A-Za-z_$][\w$]*)\.type===`quit-app`\)\{([A-Za-z_$][\w$]*)\.app\.quit\(\);return\}/g;
  const patchedQuitAppRegex =
    /if\([A-Za-z_$][\w$]*\.type===`quit-app`\)\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),[A-Za-z_$][\w$]*\.app\.quit\(\);return\}/;
  let patchedAny = false;
  if (patchedSource.includes(quitAppNeedle)) {
    patchedAny = true;
    patchedSource = patchedSource.split(quitAppNeedle).join(quitAppPatch);
  }
  patchedSource = patchedSource.replace(
    quitAppRegex,
    (_match, messageVar, electronVar) => {
      patchedAny = true;
      return `if(${messageVar}.type===\`quit-app\`){${quitMarkerExpression}${electronVar}.app.quit();return}`;
    },
  );
  if (!patchedAny && !patchedQuitAppRegex.test(patchedSource) && patchedSource.includes("type===`quit-app`")) {
    console.warn("WARN: Could not find quit-app IPC handler — skipping Linux explicit quit-app patch");
  }

  return patchedSource;
}

function applyLinuxTrayPatch(currentSource, iconPathExpression) {
  let patchedSource = currentSource;
  const electronVar = requireName(currentSource, "electron") ?? "n";

  const trayGuardNeedle =
    "process.platform!==`win32`&&process.platform!==`darwin`?null:";
  const trayGuardPatch =
    "process.platform!==`win32`&&process.platform!==`darwin`&&process.platform!==`linux`?null:";
  const trayGuardIndex = patchedSource.indexOf(trayGuardNeedle);
  if (patchedSource.includes(trayGuardPatch)) {
    // Already patched.
  } else if (
    trayGuardIndex !== -1 &&
    /new [A-Za-z_$][\w$]*\.Tray\(/.test(
      patchedSource.slice(trayGuardIndex, trayGuardIndex + TRAY_GUARD_LOOKAHEAD),
    )
  ) {
    patchedSource = patchedSource.replace(trayGuardNeedle, trayGuardPatch);
  } else {
    console.warn("WARN: Could not find tray platform guard — skipping Linux tray guard patch");
  }

  if (iconPathExpression != null) {
    const trayIconNeedle =
      `for(let e of o){let t=${electronVar}.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}return{defaultIcon:await ${electronVar}.app.getFileIcon(process.execPath,{size:process.platform===\`win32\`?\`small\`:\`normal\`}),chronicleRunningIcon:null}}`;
    const trayIconPatch =
      `for(let e of o){let t=${electronVar}.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}if(process.platform===\`linux\`){let e=${electronVar}.nativeImage.createFromPath(${iconPathExpression});if(!e.isEmpty())return{defaultIcon:e,chronicleRunningIcon:null}}return{defaultIcon:await ${electronVar}.app.getFileIcon(process.execPath,{size:process.platform===\`win32\`?\`small\`:\`normal\`}),chronicleRunningIcon:null}}`;
    if (
      patchedSource.includes(`nativeImage.createFromPath(${iconPathExpression})`) ||
      /app\.isPackaged\?\[\(0,[A-Za-z_$][\w$]*\.join\)\(process\.resourcesPath,[A-Za-z_$][\w$]*\)\]:\[\][^]*?nativeImage\.createFromPath/.test(patchedSource)
    ) {
      // Already patched.
    } else if (patchedSource.includes(trayIconNeedle)) {
      patchedSource = patchedSource.replace(trayIconNeedle, trayIconPatch);
    } else if (
      /for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.nativeImage\.createFromPath\(\1\);if\(!\3\.isEmpty\(\)\)return\{defaultIcon:\3,chronicleRunningIcon:null\}\}return\{defaultIcon:await \4\.app\.getFileIcon\(process\.execPath,\{size:process\.platform===`win32`\?`small`:`normal`\}\),chronicleRunningIcon:null\}\}/.test(patchedSource)
    ) {
      patchedSource = patchedSource.replace(
        /for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.nativeImage\.createFromPath\(\1\);if\(!\3\.isEmpty\(\)\)return\{defaultIcon:\3,chronicleRunningIcon:null\}\}return\{defaultIcon:await \4\.app\.getFileIcon\(process\.execPath,\{size:process\.platform===`win32`\?`small`:`normal`\}\),chronicleRunningIcon:null\}\}/,
        (_match, iconPathVar, candidatesVar, imageVar, electronAlias) =>
          `for(let ${iconPathVar} of ${candidatesVar}){let ${imageVar}=${electronAlias}.nativeImage.createFromPath(${iconPathVar});if(!${imageVar}.isEmpty())return{defaultIcon:${imageVar},chronicleRunningIcon:null}}if(process.platform===\`linux\`){let ${iconPathVar}=${electronAlias}.nativeImage.createFromPath(${iconPathExpression});if(!${iconPathVar}.isEmpty())return{defaultIcon:${iconPathVar},chronicleRunningIcon:null}}return{defaultIcon:await ${electronAlias}.app.getFileIcon(process.execPath,{size:process.platform===\`win32\`?\`small\`:\`normal\`}),chronicleRunningIcon:null}}`,
      );
    } else {
      console.warn("WARN: Could not find tray icon fallback — skipping Linux tray icon patch");
    }
  }

  const patchedCloseToTrayRegex =
    /if\(\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&!this\.isAppQuitting&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)&&this\.options\.canHideLast(?:Local)?WindowToTray\?\.\(\)===!0&&![A-Za-z_$][\w$]*\)\{[A-Za-z_$][\w$]*\.preventDefault\(\),[A-Za-z_$][\w$]*\.hide\(\);return\}/;
  if (patchedCloseToTrayRegex.test(patchedSource)) {
    // Already patched with a newer minifier's window variable.
  } else {
    const closeToTrayRegex =
      /if\(process\.platform===`win32`&&!this\.isAppQuitting&&this\.options\.(canHideLast(?:Local)?WindowToTray)\?\.\(\)===!0&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)\.preventDefault\(\),([A-Za-z_$][\w$]*)\.hide\(\);return\}/;
    const closeToTrayMatch = patchedSource.match(closeToTrayRegex);
    if (closeToTrayMatch != null) {
      const [, gateMethodName, hasOtherWindowVar, eventVar, windowVar] = closeToTrayMatch;
      patchedSource = patchedSource.replace(
        closeToTrayRegex,
        `if((process.platform===\`win32\`||process.platform===\`linux\`)&&!this.isAppQuitting&&!(typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress())&&this.options.${gateMethodName}?.()===!0&&!${hasOtherWindowVar}){${eventVar}.preventDefault(),${windowVar}.hide();return}`,
      );
    } else {
      console.warn("WARN: Could not find close-to-tray condition — skipping Linux close-to-tray patch");
    }
  }

  const trayContextMethodNeedle =
    "trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};constructor(";
  const trayContextMethodPatch =
    `trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};setLinuxTrayContextMenu(){let e=${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());this.tray.setContextMenu?.(e);return e}constructor(`;
  if (patchedSource.includes("setLinuxTrayContextMenu(){")) {
    patchedSource = patchedSource.replace(
      /setLinuxTrayContextMenu\(\)\{let e=[A-Za-z_$][\w$]*\.Menu\.buildFromTemplate\(this\.getNativeTrayMenuItems\(\)\);/,
      `setLinuxTrayContextMenu(){let e=${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());`,
    );
  } else if (patchedSource.includes(trayContextMethodNeedle)) {
    patchedSource = patchedSource.replace(trayContextMethodNeedle, trayContextMethodPatch);
  } else {
    console.warn("WARN: Could not find tray controller fields — skipping Linux tray context menu method patch");
  }

  const trayClickNeedle =
    "this.tray.on(`click`,()=>{this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}";
  const trayClickPatchWithoutContextSetup =
    "this.tray.on(`click`,()=>{process.platform===`linux`?this.openNativeTrayMenu():this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}";
  const trayClickPatch =
    "process.platform===`linux`&&this.setLinuxTrayContextMenu(),this.tray.on(`click`,()=>{process.platform===`linux`?this.openNativeTrayMenu():this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}";
  const canSetLinuxTrayContextMenu = patchedSource.includes("setLinuxTrayContextMenu(){");
  if (patchedSource.includes("process.platform===`linux`&&this.setLinuxTrayContextMenu(),this.tray.on(`click`")) {
    // Already patched.
  } else if (patchedSource.includes(trayClickNeedle)) {
    patchedSource = patchedSource.replace(
      trayClickNeedle,
      canSetLinuxTrayContextMenu ? trayClickPatch : trayClickPatchWithoutContextSetup,
    );
  } else if (canSetLinuxTrayContextMenu && patchedSource.includes(trayClickPatchWithoutContextSetup)) {
    patchedSource = patchedSource.replace(trayClickPatchWithoutContextSetup, trayClickPatch);
  } else {
    console.warn("WARN: Could not find tray click handler — skipping Linux tray menu click patch");
  }

  const trayMenuBuildNeedle =
    `openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());`;
  const trayMenuBuildExistingPatch =
    `openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=process.platform===\`linux\`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());`;
  const trayMenuBuildPatch =
    `openNativeTrayMenu(){if(process.platform===\`linux\`&&(typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress()))return;this.updateChronicleTrayIcon();let e=process.platform===\`linux\`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());`;
  const trayMenuBuildAnyAliasRegex =
    /openNativeTrayMenu\(\)\{this\.updateChronicleTrayIcon\(\);let e=([A-Za-z_$][\w$]*)\.Menu\.buildFromTemplate\(this\.getNativeTrayMenuItems\(\)\);/;
  const trayMenuBuildExistingAnyAliasRegex =
    /openNativeTrayMenu\(\)\{this\.updateChronicleTrayIcon\(\);let e=process\.platform===`linux`&&this\.setLinuxTrayContextMenu\?this\.setLinuxTrayContextMenu\(\):([A-Za-z_$][\w$]*)\.Menu\.buildFromTemplate\(this\.getNativeTrayMenuItems\(\)\);/;
  if (patchedSource.includes("openNativeTrayMenu(){if(process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress()))return;")) {
    // Already patched.
  } else if (patchedSource.includes(trayMenuBuildExistingPatch)) {
    patchedSource = patchedSource.replace(trayMenuBuildExistingPatch, trayMenuBuildPatch);
  } else if (trayMenuBuildExistingAnyAliasRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(trayMenuBuildExistingAnyAliasRegex, trayMenuBuildPatch);
  } else if (patchedSource.includes(trayMenuBuildNeedle)) {
    patchedSource = patchedSource.replace(trayMenuBuildNeedle, trayMenuBuildPatch);
  } else if (trayMenuBuildAnyAliasRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(trayMenuBuildAnyAliasRegex, trayMenuBuildPatch);
  } else {
    console.warn("WARN: Could not find tray native menu builder — skipping Linux tray context menu builder patch");
  }

  const trayContextMenuNeedle =
    "e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}";
  const trayContextMenuPatch =
    "if(process.platform===`linux`)return;e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}";
  const oldLinuxPopupPatch =
    "e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),process.platform===`linux`&&this.tray.setContextMenu?.(e),this.tray.popUpContextMenu(e)}";
  const badLinuxPopupPatch =
    "e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),if(process.platform===`linux`)return;e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}";
  if (patchedSource.includes("if(process.platform===`linux`)return;e.once(`menu-will-show`")) {
    // Already patched.
  } else if (patchedSource.includes(badLinuxPopupPatch)) {
    patchedSource = patchedSource.replace(badLinuxPopupPatch, trayContextMenuPatch);
  } else if (patchedSource.includes(oldLinuxPopupPatch)) {
    patchedSource = patchedSource.replace(oldLinuxPopupPatch, trayContextMenuPatch);
  } else if (patchedSource.includes(trayContextMenuNeedle)) {
    patchedSource = patchedSource.replace(trayContextMenuNeedle, trayContextMenuPatch);
  } else {
    console.warn("WARN: Could not find tray native menu popup — skipping Linux tray popup guard patch");
  }

  const trayMenuThreadsNeedle =
    "case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads;return";
  const trayMenuThreadsExistingPatch =
    "case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&this.setLinuxTrayContextMenu?.();return";
  const trayMenuThreadsPatch =
    "case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.setLinuxTrayContextMenu?.();return";
  if (patchedSource.includes("this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.setLinuxTrayContextMenu?.()")) {
    // Already patched.
  } else if (patchedSource.includes(trayMenuThreadsExistingPatch)) {
    patchedSource = patchedSource.replace(trayMenuThreadsExistingPatch, trayMenuThreadsPatch);
  } else if (patchedSource.includes(trayMenuThreadsNeedle)) {
    patchedSource = patchedSource.replace(trayMenuThreadsNeedle, trayMenuThreadsPatch);
  } else {
    console.warn("WARN: Could not find tray menu thread update handler — skipping Linux tray context refresh patch");
  }

  const trayStartupNeedle = "E&&oe();";
  const previousTrayStartupPatch = "(E||process.platform===`linux`)&&oe();";
  const trayEnabledExpression = "process.platform===`linux`&&(typeof codexLinuxIsTrayEnabled!==`function`||codexLinuxIsTrayEnabled())";
  const trayStartupPatch = `(E||${trayEnabledExpression})&&oe();`;
  patchedSource = patchedSource.replaceAll(
    "process.platform===`linux`&&codexLinuxIsTrayEnabled())&&",
    `${trayEnabledExpression})&&`,
  );
  if (patchedSource.includes(trayStartupPatch)) {
    // Already patched.
  } else if (patchedSource.includes(previousTrayStartupPatch)) {
    patchedSource = patchedSource.replace(previousTrayStartupPatch, trayStartupPatch);
  } else if (patchedSource.includes(trayStartupNeedle)) {
    patchedSource = patchedSource.replace(trayStartupNeedle, trayStartupPatch);
  } else {
    const traySetup = findDynamicTraySetup(patchedSource);
    const dynamicTrayStartupMatch = traySetup == null
      ? null
      : findDynamicTrayStartupCall(patchedSource, traySetup.setupFn, traySetup.index);
    if (
      traySetup != null &&
      patchedSource.includes(`${trayEnabledExpression})&&${traySetup.setupFn}();`)
    ) {
      // Already patched with a newer minifier's tray setup identifier.
    } else if (dynamicTrayStartupMatch != null) {
      const isWindowsVar = dynamicTrayStartupMatch[1];
      patchedSource = `${patchedSource.slice(0, dynamicTrayStartupMatch.index)}(${isWindowsVar}||${trayEnabledExpression})&&${traySetup.setupFn}();${patchedSource.slice(dynamicTrayStartupMatch.index + dynamicTrayStartupMatch[0].length)}`;
    } else {
      console.warn("WARN: Could not find tray startup call — skipping Linux tray startup patch");
    }
  }

  return patchedSource;
}

function buildLinuxBuildInfoHelpers(electronVar, fsVar, pathVar) {
  return `function codexLinuxBuildInfoPaths(){let e=[];try{e.push((0,${pathVar}.join)(process.resourcesPath,\`codex-linux-build-info.json\`)),e.push((0,${pathVar}.join)(process.resourcesPath,\`..\`,\`.codex-linux\`,\`build-info.json\`))}catch{}return e}function codexLinuxReadBuildInfo(){for(let e of codexLinuxBuildInfoPaths())try{if(${fsVar}.existsSync(e)){let t=JSON.parse(${fsVar}.readFileSync(e,\`utf8\`));return t&&typeof t===\`object\`&&!Array.isArray(t)?t:null}}catch{}return null}function codexLinuxBuildInfoValue(e,t=\`unknown\`){return typeof e===\`string\`&&e.trim().length>0?e:Array.isArray(e)&&e.length>0?e.join(\`, \`):e==null?t:String(e)}function codexLinuxBuildInfoCommitUrl(e){let t=e?.source?.commitUrl;return typeof t===\`string\`&&/^https:\\/\\/github\\.com\\/[^/\\s]+\\/[^/\\s]+\\/commit\\/[0-9a-f]{7,40}$/i.test(t)?t:null}function codexLinuxBuildInfoDetail(e){if(!e)return\`No Linux build metadata file was found in this app install.\`;let t=e.linuxTarget??{},n=t.distro??{},r=e.upstreamDmg??{},i=e.source??{},a=e.linuxFeatures?.enabled??[],o=e.packageProfile??{},s=i.shortCommit||i.commit,c=s?i.dirty?\`\${s} (dirty)\`:s:\`unknown\`,l=n.prettyName||[n.id,n.versionId].filter(Boolean).join(\` \`)||\`unknown\`,u=codexLinuxBuildInfoCommitUrl(e);return[\`Linux package profile: \${codexLinuxBuildInfoValue(o.label)}\`,\`Distro: \${l}\`,\`Package manager: \${codexLinuxBuildInfoValue(t.packageManager??o.packageManager)}\`,\`Package format: \${codexLinuxBuildInfoValue(t.packageFormat??o.format)}\`,\`Enabled features: \${a.length>0?a.join(\`, \`):\`none\`}\`,\`Upstream app version: \${codexLinuxBuildInfoValue(r.appVersion)}\`,\`Upstream DMG SHA256: \${codexLinuxBuildInfoValue(r.sha256)}\`,\`Electron: \${codexLinuxBuildInfoValue(e.electronVersion)}\`,\`Linux source revision: \${c}\`,...(u?[\`Source commit URL: \${u}\`]:[]),\`Source branch: \${codexLinuxBuildInfoValue(i.branch)}\`,\`Generated: \${codexLinuxBuildInfoValue(e.generatedAt)}\`].join(\`\\n\`)}async function codexLinuxShowBuildInfo(){try{let e=codexLinuxReadBuildInfo(),t=codexLinuxBuildInfoCommitUrl(e),n=t?[\`Open Commit\`,\`OK\`]:[\`OK\`],r=await ${electronVar}.dialog?.showMessageBox({type:\`info\`,buttons:n,defaultId:t?1:0,cancelId:t?1:0,noLink:!0,message:\`Codex Desktop Control build information\`,detail:codexLinuxBuildInfoDetail(e)});t&&r?.response===0&&await ${electronVar}.shell?.openExternal(t)}catch{}}`;
}

function findLinuxBuildInfoHelperInsertionIndex(source, classMatch, helpMenuMatch) {
  if (classMatch?.index != null) {
    return classMatch.index;
  }
  if (helpMenuMatch?.index == null) {
    return null;
  }

  const statementStart = source.lastIndexOf(";", helpMenuMatch.index) + 1;
  const insertionIndex = statementStart === 0 ? 0 : statementStart;
  return insertionIndex <= helpMenuMatch.index ? insertionIndex : null;
}

function applyLinuxBuildInfoTrayPatch(currentSource) {
  const electronVar = requireName(currentSource, "electron");
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  const hasHelper = currentSource.includes("function codexLinuxShowBuildInfo()");
  if (!hasHelper && (electronVar == null || fsVar == null || pathVar == null)) {
    console.warn("WARN: Could not find build info module bindings — skipping Linux build info tray patch");
    return currentSource;
  }

  let patchedSource = currentSource;
  let changed = false;
  const trayMenuRegex = /getNativeTrayMenuItems\(\)\{[^]*?return\[/g;
  const classRegex = /var [A-Za-z_$][\w$]*=class\{[^]*?getNativeTrayMenuItems\(\)\{[^]*?return\[/;
  const helpMenuPattern = /\{role:`help`,id:[A-Za-z_$][\w$]*\.bn\.help,submenu:\[/;
  const currentHelpMenuPattern = /\{role:`help`,id:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.help,submenu:\[/;
  const helperInsertionIndex = findLinuxBuildInfoHelperInsertionIndex(
    currentSource,
    currentSource.match(classRegex),
    currentSource.match(helpMenuPattern) ?? currentSource.match(currentHelpMenuPattern),
  );
  const canInstallHelper = hasHelper || helperInsertionIndex != null;
  const trayMenuMatch = patchedSource.match(trayMenuRegex);
  if (trayMenuMatch == null && !patchedSource.includes("role:`help`")) {
    console.warn("WARN: Could not find tray menu items method — skipping Linux build info tray patch");
  } else if (
    trayMenuMatch != null &&
    !/getNativeTrayMenuItems\(\)\{[^]*?label:`Build Information`,click:\(\)=>\{codexLinuxShowBuildInfo\(\)\}/.test(patchedSource)
  ) {
    const menuPrefix =
      "...process.platform===`linux`?[{label:`Build Information`,click:()=>{codexLinuxShowBuildInfo()}},{type:`separator`}]:[],";
    patchedSource = patchedSource.replace(trayMenuRegex, (match) => `${match}${menuPrefix}`);
    changed = true;
  }

  const helpMenuRegex = /\{role:`help`,id:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.help,submenu:\[/g;
  if (
    !/\{role:`help`,id:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.help,submenu:\[\.\.\.process\.platform===`linux`\?\[\{label:`Build Information`,click:\(\)=>\{codexLinuxShowBuildInfo\(\)\}\},\{type:`separator`\}\]:\[\],/.test(patchedSource)
  ) {
    if (canInstallHelper) {
      let patchedHelpMenu = false;
      patchedSource = patchedSource.replace(helpMenuRegex, (match) => {
        patchedHelpMenu = true;
        return `${match}...process.platform===\`linux\`?[{label:\`Build Information\`,click:()=>{codexLinuxShowBuildInfo()}},{type:\`separator\`}]:[],`;
      });
      changed = changed || patchedHelpMenu;
      if (!patchedHelpMenu && patchedSource.includes("role:`help`")) {
        console.warn("WARN: Could not find Help menu insertion point — skipping Linux build info app menu patch");
      }
    } else if (patchedSource.includes("role:`help`")) {
      console.warn("WARN: Could not find Help menu insertion point — skipping Linux build info app menu patch");
    }
  }

  if (!changed || hasHelper) {
    return patchedSource;
  }

  const classMatch = patchedSource.match(classRegex);
  const helpMenuMatch = patchedSource.match(helpMenuPattern) ?? patchedSource.match(currentHelpMenuPattern);
  const helperIndex = findLinuxBuildInfoHelperInsertionIndex(patchedSource, classMatch, helpMenuMatch);
  if (helperIndex == null) {
    console.warn("WARN: Could not find build info helper insertion point — skipping Linux build info patch");
    return currentSource;
  }

  const helpers = buildLinuxBuildInfoHelpers(electronVar, fsVar, pathVar);
  return `${patchedSource.slice(0, helperIndex)}${helpers};${patchedSource.slice(helperIndex)}`;
}

function applyLinuxSingleInstancePatch(currentSource) {
  let patchedSource = currentSource;

  const singleInstanceLockNeedle =
    "agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});let A=Date.now();await n.app.whenReady()";
  const singleInstanceLockPatch =
    "agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});if(process.platform===`linux`&&process.env.CODEX_LINUX_MULTI_LAUNCH!==`1`&&!n.app.requestSingleInstanceLock()){n.app.quit();return}let A=Date.now();await n.app.whenReady()";
  const unguardedSingleInstanceLock =
    "process.platform===`linux`&&!n.app.requestSingleInstanceLock()";
  const guardedSingleInstanceLock =
    "process.platform===`linux`&&process.env.CODEX_LINUX_MULTI_LAUNCH!==`1`&&!n.app.requestSingleInstanceLock()";
  if (patchedSource.includes(guardedSingleInstanceLock)) {
    // Already patched.
  } else if (patchedSource.includes(unguardedSingleInstanceLock)) {
    patchedSource = patchedSource.replaceAll(unguardedSingleInstanceLock, guardedSingleInstanceLock);
  } else if (patchedSource.includes(singleInstanceLockNeedle)) {
    patchedSource = patchedSource.replace(singleInstanceLockNeedle, singleInstanceLockPatch);
  } else if (patchedSource.includes("setSecondInstanceArgsHandler")) {
    // Newer bundles take the single-instance lock in bootstrap.js and hand args into main here.
  } else {
    console.warn("WARN: Could not find startup handoff point — skipping Linux single-instance lock patch");
  }

  const secondInstanceHandlerNeedle =
    "l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=";
  const secondInstanceHandlerExistingPatch =
    "let codexLinuxSecondInstanceHandler=(e,t)=>{R.deepLinks.queueProcessArgs(t)||ie()};process.platform===`linux`&&(n.app.on(`second-instance`,codexLinuxSecondInstanceHandler),k.add(()=>{n.app.off(`second-instance`,codexLinuxSecondInstanceHandler)})),l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=";
  const secondInstanceHandlerPatch =
    "let codexLinuxSecondInstanceHandler=(e,t)=>{(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())?void 0:R.deepLinks.queueProcessArgs(t)||ie()},codexLinuxBeforeQuitHandler=()=>{typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress()};process.platform===`linux`&&(n.app.on(`before-quit`,codexLinuxBeforeQuitHandler),k.add(()=>{n.app.off(`before-quit`,codexLinuxBeforeQuitHandler)}),n.app.on(`second-instance`,codexLinuxSecondInstanceHandler),k.add(()=>{n.app.off(`second-instance`,codexLinuxSecondInstanceHandler)})),l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=";
  if (
    patchedSource.includes("codexLinuxBeforeQuitHandler=()=>{typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress()}") &&
    patchedSource.includes("(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())?void 0:R.deepLinks.queueProcessArgs(t)||ie()")
  ) {
    // Already patched.
  } else if (patchedSource.includes(secondInstanceHandlerExistingPatch)) {
    patchedSource = patchedSource.replace(secondInstanceHandlerExistingPatch, secondInstanceHandlerPatch);
  } else if (patchedSource.includes(secondInstanceHandlerNeedle)) {
    patchedSource = patchedSource.replace(secondInstanceHandlerNeedle, secondInstanceHandlerPatch);
  } else if (patchedSource.includes("setSecondInstanceArgsHandler")) {
    // bootstrap.js owns the Electron second-instance event and calls this bundle's handler.
  } else {
    console.warn("WARN: Could not find second-instance handler — skipping Linux second-instance focus patch");
  }

  return patchedSource;
}

const LINUX_DESKTOP_BROWSER_MCP_FEATURE_FLAGS =
  "computerUse:!0,computerUseNodeRepl:!0,inAppBrowserUse:!0,inAppBrowserUseAllowed:!0,externalBrowserUse:!0,externalBrowserUseAllowed:!0";

function applyLinuxDesktopBrowserMcpDefaultsPatch(currentSource) {
  const jsReplDefaultNeedle = `Jn={"features.js_repl":!1}`;
  const jsReplDefaultPatch = `Jn={"features.js_repl":!0}`;
  const jsReplDefaultRegex = /([A-Za-z_$][\w$]*)=\{"features\.js_repl":!1\}/;

  const win32OnlyWeNeedle =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`win32`&&([A-Za-z_$][\w$]*)\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:([A-Za-z_$][\w$]*),/;

  const linuxComputerOnlyWeNeedle =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`linux`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:([A-Za-z_$][\w$]*)===`win32`&&([A-Za-z_$][\w$]*)\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:([A-Za-z_$][\w$]*),/;

  const currentLinuxComputerOnlyNeedle =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`linux`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:([A-Za-z_$][\w$]*)===`win32`&&([A-Za-z_$][\w$]*)\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:([A-Za-z_$][\w$]*),/;

  const currentWindowsOnlyNeedle =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`win32`&&([A-Za-z_$][\w$]*)\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:([A-Za-z_$][\w$]*),/;

  const alreadyPatched =
    currentSource.includes(LINUX_DESKTOP_BROWSER_MCP_FEATURE_FLAGS) &&
    currentSource.includes(`{"features.js_repl":!0}`);

  if (alreadyPatched) {
    return currentSource;
  }

  let patchedSource = currentSource;
  let wePatched = false;

  if (currentLinuxComputerOnlyNeedle.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      currentLinuxComputerOnlyNeedle,
      (_, gateVar, platformVar, featuresVar, winPlatformVar, envVar, winFeaturesVar, fallbackVar) =>
        `${gateVar}=${platformVar}===\`linux\`?{...${featuresVar},${LINUX_DESKTOP_BROWSER_MCP_FEATURE_FLAGS}}:${winPlatformVar}===\`win32\`&&${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===\`1\`?{...${winFeaturesVar},computerUse:!0,computerUseNodeRepl:!0}:${fallbackVar},`,
    );
    wePatched = true;
  } else if (linuxComputerOnlyWeNeedle.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      linuxComputerOnlyWeNeedle,
      (_, gateVar, platformVar, featuresVar, winPlatformVar, envVar, winFeaturesVar, fallbackVar) =>
        `let ${gateVar}=${platformVar}===\`linux\`?{...${featuresVar},${LINUX_DESKTOP_BROWSER_MCP_FEATURE_FLAGS}}:${winPlatformVar}===\`win32\`&&${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===\`1\`?{...${winFeaturesVar},computerUse:!0,computerUseNodeRepl:!0}:${fallbackVar},`,
    );
    wePatched = true;
  } else if (win32OnlyWeNeedle.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      win32OnlyWeNeedle,
      (_, gateVar, platformVar, envVar, featuresVar, fallbackVar) =>
        `let ${gateVar}=${platformVar}===\`linux\`?{...${featuresVar},${LINUX_DESKTOP_BROWSER_MCP_FEATURE_FLAGS}}:${platformVar}===\`win32\`&&${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===\`1\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${fallbackVar},`,
    );
    wePatched = true;
  } else if (currentWindowsOnlyNeedle.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      currentWindowsOnlyNeedle,
      (_, gateVar, platformVar, envVar, featuresVar, fallbackVar) =>
        `${gateVar}=${platformVar}===\`linux\`?{...${featuresVar},${LINUX_DESKTOP_BROWSER_MCP_FEATURE_FLAGS}}:${platformVar}===\`win32\`&&${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===\`1\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${fallbackVar},`,
    );
    wePatched = true;
  }

  if (!wePatched && patchedSource.includes("CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE")) {
    console.warn(
      "WARN: Could not find desktop feature resolver gate — skipping Linux browser MCP defaults patch",
    );
  }

  if (patchedSource.includes(jsReplDefaultNeedle)) {
    patchedSource = patchedSource.split(jsReplDefaultNeedle).join(jsReplDefaultPatch);
  } else if (jsReplDefaultRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      jsReplDefaultRegex,
      (_, configVar) => `${configVar}={"features.js_repl":!0}`,
    );
  } else if (!patchedSource.includes(`{"features.js_repl":!0}`)) {
    console.warn(
      "WARN: Could not find js_repl default config needle — skipping Linux js_repl default patch",
    );
  }

  return patchedSource;
}

function applyLinuxBundledCodexCliResolverPatch(currentSource) {
  const currentResolverCandidates =
    "t?.resourcesPath&&(n.push((0,r.join)(t.resourcesPath,a)),n.push((0,r.join)(t.resourcesPath,`app.asar.unpacked`,a)))";
  const patchedResolverCandidates =
    "t?.resourcesPath&&(n.push((0,r.join)(t.resourcesPath,`bin`,a)),n.push((0,r.join)(t.resourcesPath,a)),n.push((0,r.join)(t.resourcesPath,`app.asar.unpacked`,a)))";

  if (currentSource.includes(patchedResolverCandidates)) {
    return currentSource;
  }

  if (currentSource.includes(currentResolverCandidates)) {
    return currentSource.split(currentResolverCandidates).join(patchedResolverCandidates);
  }

  if (
    currentSource.includes("Unable to locate the Codex CLI binary") &&
    currentSource.includes("app.asar.unpacked")
  ) {
    console.warn(
      "WARN: Could not find bundled Codex CLI resolver candidate list - skipping Linux CLI resolver patch",
    );
  }
  return currentSource;
}

function patchLinuxBundledCodexCliResolverAssets(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    console.warn(
      `WARN: Could not find app build directory in ${buildDir} - skipping Linux CLI resolver patch`,
    );
    return { matched: 0, changed: 0 };
  }

  const marker = "Unable to locate the Codex CLI binary";
  const candidates = fs
    .readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(buildDir, name))
    .filter((candidate) => {
      try {
        return fs.readFileSync(candidate, "utf8").includes(marker);
      } catch {
        return false;
      }
    })
    .sort();

  if (candidates.length === 0) {
    console.warn(
      "WARN: Could not find bundled Codex CLI resolver bundle - skipping Linux CLI resolver patch",
    );
    return { matched: 0, changed: 0 };
  }

  let changed = 0;
  for (const candidate of candidates) {
    const currentSource = fs.readFileSync(candidate, "utf8");
    const patchedSource = applyLinuxBundledCodexCliResolverPatch(currentSource);
    if (patchedSource !== currentSource) {
      fs.writeFileSync(candidate, patchedSource, "utf8");
      changed += 1;
    }
  }

  return { matched: candidates.length, changed };
}

function applyBrowserUseNodeReplApprovalPatch(currentSource) {
  const approvalPatch =
    "startup_timeout_sec:120,tools:{js:{approval_mode:`approve`}},env:{";
  const needle = "startup_timeout_sec:120,env:{";
  const runtimeFactoryMethods = String.raw`Dn|Pn|Fa|La|Ha|\$a`;
  let patchedSource = currentSource;
  let patchedTrustedHashes = false;
  const ensureTrustedHashHelper = () => {
    if (patchedSource.includes("function codexLinuxTrustedBrowserClientSha256s(")) {
      return true;
    }
    const fsVar = requireName(patchedSource, "node:fs");
    const pathVar = requireName(patchedSource, "node:path");
    const cryptoVar = requireName(patchedSource, "node:crypto");
    if (fsVar == null || pathVar == null || cryptoVar == null) {
      return false;
    }
    const helper =
      `function codexLinuxTrustedBrowserClientSha256s(__codexHashes,__codexResourcesPath=process.resourcesPath){if(process.platform!==\`linux\`)return __codexHashes;let __codexTrustedHashes=Array.isArray(__codexHashes)?[...__codexHashes]:[],__codexBasePath=__codexResourcesPath??"";if(__codexBasePath.length===0)return Array.from(new Set(__codexTrustedHashes));for(let __codexPluginName of[\`browser\`,\`chrome\`])try{let __codexBrowserClientPath=(0,${pathVar}.join)(__codexBasePath,\`plugins\`,\`openai-bundled\`,\`plugins\`,__codexPluginName,\`scripts\`,\`browser-client.mjs\`);(0,${fsVar}.existsSync)(__codexBrowserClientPath)&&__codexTrustedHashes.push((0,${cryptoVar}.createHash)(\`sha256\`).update((0,${fsVar}.readFileSync)(__codexBrowserClientPath)).digest(\`hex\`))}catch{}return Array.from(new Set(__codexTrustedHashes))}`;
    const strictDirective = '"use strict";';
    const helperInsertionIndex = patchedSource.startsWith(strictDirective)
      ? strictDirective.length
      : 0;
    patchedSource =
      patchedSource.slice(0, helperInsertionIndex) +
      helper +
      patchedSource.slice(helperInsertionIndex);
    return true;
  };

  if (patchedSource.includes(needle)) {
    patchedSource = patchedSource.split(needle).join(approvalPatch);
  }

  const envBeforeStartupConfigRegex =
    /(\{\[`mcp_servers\.\$\{[A-Za-z_$][\w$]*\}`\]:\{args:\[\],command:[^,{}]+,env:)([^,{}]+)(,startup_timeout_sec:120)(?!,tools:\{js:\{approval_mode:`approve`\}\})/g;
  patchedSource = patchedSource.replace(
    envBeforeStartupConfigRegex,
    "$1$2$3,tools:{js:{approval_mode:`approve`}}",
  );

  const runtimeFactoryTrustedHashesRegex =
    new RegExp(String.raw`([A-Za-z_$][\w$]*)\.(${runtimeFactoryMethods})\(\{([^{}]*?trustedBrowserClientSha256s:)(?!codexLinuxTrustedBrowserClientSha256s\()([A-Za-z_$][\w$]*)(,[^{}]*?\})\)`, "g");
  if (
    requireName(patchedSource, "node:fs") != null &&
    requireName(patchedSource, "node:path") != null &&
    requireName(patchedSource, "node:crypto") != null
  ) {
    patchedSource = patchedSource.replace(
      runtimeFactoryTrustedHashesRegex,
      (match, runtimeFactoryVar, runtimeFactoryMethod, configPrefix, trustedHashesVar, configSuffix) => {
        patchedTrustedHashes = true;
        return `${runtimeFactoryVar}.${runtimeFactoryMethod}({${configPrefix}codexLinuxTrustedBrowserClientSha256s(${trustedHashesVar})${configSuffix})`;
      },
    );
  }

  const currentMainTrustedHashesParamRegex =
    /trustedBrowserClientSha256s:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\}\)\{let /g;
  patchedSource = patchedSource.replace(
    currentMainTrustedHashesParamRegex,
    (match, trustedHashesVar) => {
      if (!ensureTrustedHashHelper()) {
        return match;
      }
      patchedTrustedHashes = true;
      return match.replace("{let ", `{${trustedHashesVar}=codexLinuxTrustedBrowserClientSha256s(${trustedHashesVar});let `);
    },
  );

  const currentRuntimeConfigRegex =
    new RegExp(String.raw`([A-Za-z_$][\w$]*)\.(${runtimeFactoryMethods})\(\{([^{}]*?)nodeReplPath:([^,{}]+)(,)(?!tools:\{js:\{approval_mode:\`approve\`\}\})`, "g");
  const currentNodeReplMcpAlreadyApprovedPattern =
    String.raw`\{\[\`mcp_servers\.\$\{[A-Za-z_$][\w$]*\}\`\]:\{args:\[\],command:[^,{}]+,env:[^,{}]+,startup_timeout_sec:120,tools:\{js:\{approval_mode:\`approve\`\}\}`;
  const currentRuntimeConfigAlreadyApprovedRegex =
    new RegExp(
      String.raw`[A-Za-z_$][\w$]*\.(?:${runtimeFactoryMethods})\(\{[^{}]*?nodeReplPath:[^,{}]+,tools:\{js:\{approval_mode:\`approve\`\}\},` +
        "|" +
        currentNodeReplMcpAlreadyApprovedPattern,
    );
  let patchedAnyCurrentRuntimeConfig = false;
  patchedSource = patchedSource.replace(
    currentRuntimeConfigRegex,
    (_match, runtimeFactoryVar, runtimeFactoryMethod, configPrefix, nodeReplPathVar, comma) => {
      patchedAnyCurrentRuntimeConfig = true;
      return `${runtimeFactoryVar}.${runtimeFactoryMethod}({${configPrefix}nodeReplPath:${nodeReplPathVar}${comma}tools:{js:{approval_mode:\`approve\`}},`;
    },
  );

  const trustedHashesRegex =
    /trustedBrowserClientSha256s:([^,{}]+)\|\|([^,{}]+)\?([A-Za-z_$][\w$]*):\[\]/g;
  patchedSource = patchedSource.replace(
    trustedHashesRegex,
    (match, browserUseEnabledVar, nativePipeEnabledVar, trustedHashesVar) => {
      if (match.includes("codexLinuxTrustedBrowserClientSha256s(")) {
        return match;
      }
      patchedTrustedHashes = true;
      return `trustedBrowserClientSha256s:${browserUseEnabledVar}||${nativePipeEnabledVar}?codexLinuxTrustedBrowserClientSha256s(${trustedHashesVar}):[]`;
    },
  );

  if (
    patchedTrustedHashes &&
    !patchedSource.includes("function codexLinuxTrustedBrowserClientSha256s(")
  ) {
    if (!ensureTrustedHashHelper()) {
      console.warn(
        "WARN: Could not find fs/path/crypto aliases — skipping Linux Browser Use trusted hash patch",
      );
      patchedSource = patchedSource.replace(
        /trustedBrowserClientSha256s:([^,{}]+)\|\|([^,{}]+)\?codexLinuxTrustedBrowserClientSha256s\(([A-Za-z_$][\w$]*)\):\[\]/g,
        "trustedBrowserClientSha256s:$1||$2?$3:[]",
      );
      patchedSource = patchedSource.replace(
        /trustedBrowserClientSha256s:codexLinuxTrustedBrowserClientSha256s\(([A-Za-z_$][\w$]*)\)/g,
        "trustedBrowserClientSha256s:$1",
      );
      patchedTrustedHashes = false;
    }
  }

  if (
    !patchedTrustedHashes &&
    !patchedSource.includes("codexLinuxTrustedBrowserClientSha256s(") &&
    patchedSource.includes("NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S")
  ) {
    console.warn(
      "WARN: Could not find Browser Use trusted hash insertion point — skipping Linux Browser Use trusted hash patch",
    );
  }

  if (
    patchedSource === currentSource &&
    !patchedSource.includes(approvalPatch) &&
    !patchedAnyCurrentRuntimeConfig &&
    !currentRuntimeConfigAlreadyApprovedRegex.test(patchedSource) &&
    !patchedTrustedHashes &&
    !patchedSource.includes("codexLinuxTrustedBrowserClientSha256s(")
  ) {
    console.warn(
      "WARN: Could not find Browser Use node_repl config insertion point — skipping node_repl approval patch",
    );
  }

  return patchedSource;
}

function applyLinuxChromeExtensionStatusPatch(currentSource) {
  if (currentSource.includes("codexLinuxChromeProfileRoots")) {
    return currentSource;
  }

  const fsVar = requireName(currentSource, "node:fs");
  const osVar = requireName(currentSource, "node:os");
  const pathVar = requireName(currentSource, "node:path");
  if (fsVar == null || osVar == null || pathVar == null) {
    console.warn(
      "WARN: Could not find fs/os/path aliases — skipping Linux Chrome extension status patch",
    );
    return currentSource;
  }

  const unsupportedMessage =
    "Opening Chrome extension settings is only supported on macOS and Windows";
  const unsupportedMessageIndex = currentSource.indexOf(unsupportedMessage);
  const openFunctionStart =
    unsupportedMessageIndex === -1
      ? -1
      : currentSource.lastIndexOf("async function ", unsupportedMessageIndex);
  const blockStart =
    openFunctionStart === -1
      ? -1
      : currentSource.lastIndexOf("function ", openFunctionStart - 1);
  const blockEnd =
    openFunctionStart === -1
      ? -1
      : currentSource.indexOf("function ", openFunctionStart + "async function ".length);
  const originalBlock = blockEnd === -1 ? null : currentSource.slice(blockStart, blockEnd);
  if (
    blockStart === -1 ||
    blockEnd === -1 ||
    !originalBlock.includes(unsupportedMessage)
  ) {
    console.warn(
      "WARN: Could not find Chrome extension status functions — skipping Linux Chrome extension status patch",
    );
    return currentSource;
  }

  const statusFunctionName = /^function ([A-Za-z_$][\w$]*)\(\{extensionId:/.exec(
    originalBlock,
  )?.[1];
  const openFunctionName = /async function ([A-Za-z_$][\w$]*)\(\{extensionId:/.exec(
    originalBlock,
  )?.[1];
  const detectChromeFunctionName =
    /detectChromeCommand:[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)/.exec(originalBlock)?.[1];
  const runCommandFunctionName =
    /runCommand:[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)/.exec(originalBlock)?.[1];
  const extensionUrlFunctionName = /await [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,\[([A-Za-z_$][\w$]*)\(e\)\]\)/.exec(
    originalBlock,
  )?.[1];
  const macOpenFunctionName = /await [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),\[`-b`,/.exec(
    originalBlock,
  )?.[1];
  const macBundleIdName = /await [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,\[`-b`,([A-Za-z_$][\w$]*),/.exec(
    originalBlock,
  )?.[1];
  const extensionIdValidatorName = /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(e\),/.exec(
    originalBlock,
  )?.[1];
  const profileDirFunctionName = /[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(\{homeDir:/.exec(
    originalBlock,
  )?.[1];
  if (
    statusFunctionName == null ||
    openFunctionName == null ||
    detectChromeFunctionName == null ||
    runCommandFunctionName == null ||
    extensionUrlFunctionName == null ||
    macOpenFunctionName == null ||
    macBundleIdName == null ||
    extensionIdValidatorName == null ||
    profileDirFunctionName == null
  ) {
    console.warn(
      "WARN: Could not identify Chrome extension status helper names — skipping Linux Chrome extension status patch",
    );
    return currentSource;
  }

  const replacement =
    `function codexLinuxChromeProfileRoots({homeDir:__codexHomeDir,platform:__codexPlatform}){return __codexPlatform===\`linux\`?[(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`BraveSoftware\`,\`Brave-Browser\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`google-chrome\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`google-chrome-beta\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`google-chrome-unstable\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`chromium\`)]:[]}function codexLinuxChromeHasExtension({extensionId:__codexExtensionId,homeDir:__codexHomeDir,platform:__codexPlatform}){if(__codexPlatform!==\`linux\`)return!1;let __codexValidatedExtensionId=${extensionIdValidatorName}(__codexExtensionId);for(let __codexProfileRoot of codexLinuxChromeProfileRoots({homeDir:__codexHomeDir,platform:__codexPlatform})){if(!(0,${fsVar}.existsSync)(__codexProfileRoot))continue;for(let __codexProfileEntry of (0,${fsVar}.readdirSync)(__codexProfileRoot,{withFileTypes:!0}))if(__codexProfileEntry.isDirectory()&&(0,${fsVar}.existsSync)((0,${pathVar}.join)(__codexProfileRoot,__codexProfileEntry.name,\`Extensions\`,__codexValidatedExtensionId)))return!0}return!1}function codexLinuxChromeCommand(){let __codexPathEntries=(process.env.PATH??\`\`).split(\`:\`);for(let __codexBrowserCommand of[\`brave-browser\`,\`brave\`,\`google-chrome\`,\`google-chrome-stable\`,\`chromium-browser\`,\`chromium\`])for(let __codexPathEntry of __codexPathEntries){if(__codexPathEntry.length===0)continue;let __codexCandidate=(0,${pathVar}.join)(__codexPathEntry,__codexBrowserCommand);try{if((0,${fsVar}.existsSync)(__codexCandidate)&&(0,${fsVar}.statSync)(__codexCandidate).isFile())return __codexCandidate}catch{}}return null}function ${statusFunctionName}({extensionId:__codexExtensionId,homeDir:__codexHomeDir=(0,${osVar}.homedir)(),localAppDataDir:__codexLocalAppDataDir=process.env.LOCALAPPDATA,platform:__codexPlatform=process.platform}){if(__codexPlatform===\`linux\`)return codexLinuxChromeHasExtension({extensionId:__codexExtensionId,homeDir:__codexHomeDir,platform:__codexPlatform});let __codexValidatedExtensionId=${extensionIdValidatorName}(__codexExtensionId),__codexProfileDir=${profileDirFunctionName}({homeDir:__codexHomeDir,localAppDataDir:__codexLocalAppDataDir,platform:__codexPlatform});return __codexProfileDir==null||!(0,${fsVar}.existsSync)(__codexProfileDir)?!1:(0,${fsVar}.readdirSync)(__codexProfileDir,{withFileTypes:!0}).some(__codexProfileEntry=>__codexProfileEntry.isDirectory()&&(0,${fsVar}.existsSync)((0,${pathVar}.join)(__codexProfileDir,__codexProfileEntry.name,\`Extensions\`,__codexValidatedExtensionId)))}async function ${openFunctionName}({extensionId:__codexExtensionId,platform:__codexPlatform=process.platform,detectChromeCommand:__codexDetectChromeCommand=${detectChromeFunctionName},runCommand:__codexRunCommand=${runCommandFunctionName}}){if(__codexPlatform===\`darwin\`){await __codexRunCommand(${macOpenFunctionName},[\`-b\`,${macBundleIdName},${extensionUrlFunctionName}(__codexExtensionId)]);return}if(__codexPlatform===\`win32\`){let __codexChromeCommand=__codexDetectChromeCommand();if(__codexChromeCommand==null)throw Error(\`Google Chrome is not installed\`);await __codexRunCommand(__codexChromeCommand,[${extensionUrlFunctionName}(__codexExtensionId)]);return}if(__codexPlatform===\`linux\`){let __codexChromeCommand=codexLinuxChromeCommand()??__codexDetectChromeCommand();if(__codexChromeCommand==null)throw Error(\`Google Chrome, Brave, or Chromium is not installed\`);await __codexRunCommand(__codexChromeCommand,[${extensionUrlFunctionName}(__codexExtensionId)]);return}throw Error(\`Opening Chrome extension settings is only supported on macOS, Windows, and Linux\`)}`;

  return currentSource.slice(0, blockStart) + replacement + currentSource.slice(blockEnd);
}

function applyLinuxGitOriginsSourceFallbackPatch(currentSource) {
  const fallbackSource = "linux_git_origins_missing_source_fallback";
  if (currentSource.includes(`source:\`${fallbackSource}\`,requestKind:`)) {
    return currentSource;
  }

  const dynamicRegex =
    /if\(([A-Za-z_$][\w$]*)==null\)\{if\(([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\)throw Error\(`Missing git operation source for \$\{\4\}`\);return ([A-Za-z_$][\w$]*)\(\)\}return ([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\{source:\1,requestKind:\4\},\5\)/;
  const dynamicMatch = currentSource.match(dynamicRegex);
  if (dynamicMatch != null) {
    const [, sourceVar, gitGuardVar, guardFn, requestKindVar, callVar, operationContextVar, operationContextFn] = dynamicMatch;
    return currentSource.replace(
      dynamicRegex,
      `if(${sourceVar}==null){if(${gitGuardVar}.${guardFn}(${requestKindVar})){if(${requestKindVar}===\`git-origins\`)return ${operationContextVar}.${operationContextFn}({source:\`${fallbackSource}\`,requestKind:${requestKindVar}},${callVar});throw Error(\`Missing git operation source for \${${requestKindVar}}\`)}return ${callVar}()}return ${operationContextVar}.${operationContextFn}({source:${sourceVar},requestKind:${requestKindVar}},${callVar})`,
    );
  }

  if (
    currentSource.includes("Missing git operation source for") &&
    currentSource.includes("\"git-origins\":")
  ) {
    console.warn("WARN: Could not find git operation source guard — skipping git-origins fallback patch");
  }

  return currentSource;
}

function applyLinuxOwlFeatureBindingFallbackPatch(currentSource) {
  if (!currentSource.includes("electron_common_owl_features")) {
    return currentSource;
  }

  const alreadyPatchedRegex =
    /function [A-Za-z_$][\w$]*\(\)\{let ([A-Za-z_$][\w$]*)=process\._linkedBinding;if\(typeof \1!=`function`\)return \{isOwlFeatureEnabled:\(\)=>!1\};try\{return [A-Za-z_$][\w$]*\.parse\(\1\.call\(process,`electron_common_owl_features`\)\)\}catch\(([A-Za-z_$][\w$]*)\)\{if\(String\(\2\?\.message\?\?\2\)\.includes\(`No such binding was linked`\)\)return \{isOwlFeatureEnabled:\(\)=>!1\};throw \2\}\}/u;
  if (alreadyPatchedRegex.test(currentSource)) {
    return currentSource;
  }

  const upstreamNullFallbackRegex =
    /function [A-Za-z_$][\w$]*\(\)\{let ([A-Za-z_$][\w$]*)=process\._linkedBinding;if\(typeof \1!=`function`\)return null;let ([A-Za-z_$][\w$]*);try\{\2=\1\.call\(process,[A-Za-z_$][\w$]*\)\}catch\(([A-Za-z_$][\w$]*)\)\{if\([A-Za-z_$][\w$]*\(\3\)\)return null;throw \3\}return [A-Za-z_$][\w$]*\.parse\(\2\)\}/u;
  if (upstreamNullFallbackRegex.test(currentSource)) {
    return currentSource;
  }

  const loaderRegex =
    /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=process\._linkedBinding;if\(typeof \2!=`function`\)throw Error\(`Owl feature binding is unavailable`\);return ([A-Za-z_$][\w$]*)\.parse\(\2\.call\(process,`electron_common_owl_features`\)\)\}/u;
  const match = currentSource.match(loaderRegex);
  if (match == null) {
    console.warn(
      "WARN: Could not find Owl feature binding loader - skipping Linux Owl feature fallback patch",
    );
    return currentSource;
  }

  const [, fnName, linkedBindingVar, schemaVar] = match;
  const fallback = "{isOwlFeatureEnabled:()=>!1}";
  return currentSource.replace(
    loaderRegex,
    `function ${fnName}(){let ${linkedBindingVar}=process._linkedBinding;if(typeof ${linkedBindingVar}!=\`function\`)return ${fallback};try{return ${schemaVar}.parse(${linkedBindingVar}.call(process,\`electron_common_owl_features\`))}catch(t){if(String(t?.message??t).includes(\`No such binding was linked\`))return ${fallback};throw t}}`,
  );
}

function patchLinuxOwlFeatureBindingFallbackAssets(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    return { matched: 0, changed: 0 };
  }

  const candidates = fs
    .readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join(buildDir, name))
    .filter((candidate) => {
      try {
        return fs.readFileSync(candidate, "utf8").includes("electron_common_owl_features");
      } catch {
        return false;
      }
    });

  let changed = 0;
  const pendingWrites = [];
  for (const candidate of candidates) {
    const currentSource = fs.readFileSync(candidate, "utf8");
    const patchedSource = applyLinuxOwlFeatureBindingFallbackPatch(currentSource);
    if (patchedSource !== currentSource) {
      changed += 1;
      pendingWrites.push({ filePath: candidate, patchedSource });
    }
  }
  for (const { filePath, patchedSource } of pendingWrites) {
    fs.writeFileSync(filePath, patchedSource, "utf8");
  }

  return { matched: candidates.length, changed };
}

function applyLinuxRemoteControlConfigPreservationPatch(currentSource) {
  const removedLog = "Removed remote_control from config before app-server start";
  const failedLog = "Failed to remove remote_control before app-server start";
  const stripperGuardRegex =
    /async function [A-Za-z_$][\w$]*\(\{codexHome:[A-Za-z_$][\w$]*,hostConfig:([A-Za-z_$][\w$]*),logger:[A-Za-z_$][\w$]*=[^}]*\}\)\{if\(\1\.kind===`local`\)try\{/gu;
  const patchedSource = currentSource.replace(stripperGuardRegex, (needle, hostConfigVar) =>
    needle.replace(
      `if(${hostConfigVar}.kind===\`local\`)try{`,
      `if(${hostConfigVar}.kind===\`local\`&&process.platform!==\`linux\`)try{`,
    ),
  );
  if (patchedSource !== currentSource) {
    return patchedSource;
  }

  const alreadyPatchedRegex =
    /async function [A-Za-z_$][\w$]*\(\{codexHome:[A-Za-z_$][\w$]*,hostConfig:([A-Za-z_$][\w$]*),logger:[A-Za-z_$][\w$]*=[^}]*\}\)\{if\(\1\.kind===`local`&&process\.platform!==`linux`\)try\{/u;
  if (alreadyPatchedRegex.test(currentSource)) {
    return currentSource;
  }

  if (!currentSource.includes(removedLog) && !currentSource.includes(failedLog)) {
    return currentSource;
  }

  console.warn(
    "WARN: Could not find remote-control config stripper guard — skipping Linux remote-control config preservation patch",
  );
  return currentSource;
}

module.exports = {
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxBundledCodexCliResolverPatch,
  applyLinuxChromeExtensionStatusPatch,
  applyLinuxDesktopBrowserMcpDefaultsPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxBuildInfoTrayPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxMenuPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxOwlFeatureBindingFallbackPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxSetIconPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
  applyLinuxWindowOptionsPatch,
  patchLinuxBundledCodexCliResolverAssets,
  patchLinuxOwlFeatureBindingFallbackAssets,
};
