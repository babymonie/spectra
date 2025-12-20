// themeManager.js
import { app, ipcMain, shell, dialog } from "electron";
import { join, basename, extname } from "path";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile, readdir, unlink, copyFile } from "fs/promises";

function safeBaseName(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .trim();
}

function readTextIfExists(filePath) {
  try {
    if (existsSync(filePath)) return readFileSync(filePath, "utf8");
  } catch {}
  return "";
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

function makeThemePaths() {
  const userData = app.getPath("userData");
  return {
    themesDir: join(userData, "themes"),
    settingsPath: join(userData, "themes-settings.json"),
    quickCssPath: join(userData, "quickcss.css"),
  };
}

async function getThemeSettings(settingsPath) {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      selectedTheme: parsed?.selectedTheme ?? null, // null => default theme
    };
  } catch {
    return { selectedTheme: null };
  }
}

async function setThemeSettings(settingsPath, next) {
  const payload = {
    selectedTheme: next?.selectedTheme ?? null,
  };
  await writeFile(settingsPath, JSON.stringify(payload, null, 2), "utf8");
}

async function listThemes(themesDir) {
  await ensureDir(themesDir);
  const files = await readdir(themesDir).catch(() => []);
  const themes = files
    .filter((f) => f.toLowerCase().endsWith(".css"))
    .map((filename) => {
      const name = filename.replace(/\.css$/i, "");
      return { name, filename };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return themes;
}

async function readThemeCss(themesDir, themeName) {
  if (!themeName) return "";
  const safe = safeBaseName(themeName);
  const filePath = join(themesDir, `${safe}.css`);
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function removeThemeFile(themesDir, themeName) {
  const safe = safeBaseName(themeName);
  const filePath = join(themesDir, `${safe}.css`);
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyThemeFileIntoDir(themesDir, srcPath) {
  const base = basename(srcPath);
  const ext = extname(base).toLowerCase();
  if (ext !== ".css") return null;

  const stem = safeBaseName(base.replace(/\.css$/i, "")) || "theme";
  let destName = stem;
  let destPath = join(themesDir, `${destName}.css`);

  // Avoid overwriting: add suffix
  let i = 1;
  while (existsSync(destPath)) {
    destName = `${stem}-${i++}`;
    destPath = join(themesDir, `${destName}.css`);
  }

  await copyFile(srcPath, destPath);
  return destName;
}

function registerThemeIpc() {
  const { themesDir, settingsPath, quickCssPath } = makeThemePaths();

  ipcMain.handle("themes:list", async () => {
    await ensureDir(themesDir);
    const themes = await listThemes(themesDir);
    const settings = await getThemeSettings(settingsPath);
    const quickCss = readTextIfExists(quickCssPath);
    return {
      themes,
      selectedTheme: settings.selectedTheme,
      quickCssLength: quickCss.length,
    };
  });

  ipcMain.handle("themes:getActiveCss", async () => {
    await ensureDir(themesDir);
    const settings = await getThemeSettings(settingsPath);
    const themeCss = await readThemeCss(themesDir, settings.selectedTheme);
    const quickCss = readTextIfExists(quickCssPath);
    return { themeCss, quickCss, selectedTheme: settings.selectedTheme };
  });

  ipcMain.handle("themes:select", async (_evt, themeNameOrNull) => {
    const next = themeNameOrNull ? safeBaseName(themeNameOrNull) : null;
    await setThemeSettings(settingsPath, { selectedTheme: next });
    const themeCss = await readThemeCss(themesDir, next);
    const quickCss = readTextIfExists(quickCssPath);
    return { themeCss, quickCss, selectedTheme: next };
  });

  ipcMain.handle("themes:openFolder", async () => {
    await ensureDir(themesDir);
    // openPath returns empty string on success
    const res = await shell.openPath(themesDir);
    return { ok: res === "", error: res || null, path: themesDir };
  });

  ipcMain.handle("themes:importDialog", async () => {
    await ensureDir(themesDir);
    const result = await dialog.showOpenDialog({
      title: "Import Theme CSS",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "CSS", extensions: ["css"] }],
    });
    if (result.canceled) return { imported: [], canceled: true };

    const imported = [];
    for (const filePath of result.filePaths) {
      const name = await copyThemeFileIntoDir(themesDir, filePath);
      if (name) imported.push(name);
    }
    return { imported, canceled: false };
  });

  ipcMain.handle("themes:remove", async (_evt, themeName) => {
    await ensureDir(themesDir);
    const ok = await removeThemeFile(themesDir, themeName);

    // If you deleted the active theme, revert to default
    const settings = await getThemeSettings(settingsPath);
    if (ok && settings.selectedTheme === themeName) {
      await setThemeSettings(settingsPath, { selectedTheme: null });
    }

    return { ok };
  });

  ipcMain.handle("themes:getQuickCss", async () => {
    const quickCss = readTextIfExists(quickCssPath);
    return { quickCss };
  });

  ipcMain.handle("themes:setQuickCss", async (_evt, cssText) => {
    const css = String(cssText ?? "");
    await writeFile(quickCssPath, css, "utf8");
    return { ok: true, quickCssLength: css.length };
  });

  return { themesDir };
}

const themeManager = { registerThemeIpc };
export default themeManager;
