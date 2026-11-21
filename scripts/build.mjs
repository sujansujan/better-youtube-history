/**
 * scripts/build.mjs
 * Builds clean, unminified, store-validated packages for Chrome Web Store and Firefox AMO.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const ICONS_DIR = path.join(ROOT, 'icons');
const MANIFESTS_DIR = path.join(ROOT, 'manifests');
const DIST_DIR = path.join(ROOT, 'dist');

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function validateBuild(target, targetDir, manifest) {
    const errors = [];

    if (manifest.manifest_version !== 3) {
        errors.push('manifest_version must be 3');
    }

    if (target === 'chrome') {
        if (!manifest.background?.service_worker) {
            errors.push('Chrome manifest must define background.service_worker');
        }
        if (manifest.background?.scripts) {
            errors.push('Chrome MV3 manifest must not define background.scripts');
        }
        if (manifest.browser_specific_settings) {
            errors.push('Chrome manifest should not include browser_specific_settings');
        }
    } else if (target === 'firefox') {
        if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
            errors.push('Firefox manifest must define background.scripts');
        }
        const gecko = manifest.browser_specific_settings?.gecko;
        if (!gecko?.id) {
            errors.push('Firefox manifest must define browser_specific_settings.gecko.id');
        }
        if (gecko?.data_collection_permissions && parseFloat(gecko.strict_min_version) < 140) {
            errors.push('Firefox manifest with data_collection_permissions requires strict_min_version >= 140.0');
        }
    }

    // Verify all referenced files exist inside targetDir
    const referencedFiles = [
        ...Object.values(manifest.icons || {}),
        ...Object.values(manifest.action?.default_icon || {}),
        manifest.action?.default_popup,
        manifest.background?.service_worker,
        ...(manifest.background?.scripts || []),
        ...(manifest.content_scripts || []).flatMap((cs) => cs.js || [])
    ].filter(Boolean);

    for (const rel of referencedFiles) {
        const full = path.join(targetDir, rel);
        if (!fs.existsSync(full)) {
            errors.push(`Missing referenced file: ${rel}`);
        }
    }

    // Verify no forbidden remote script/font URLs in HTML
    const popupHtml = fs.readFileSync(path.join(targetDir, 'popup.html'), 'utf8');
    if (/https?:\/\/fonts\.googleapis\.com/i.test(popupHtml)) {
        errors.push('popup.html must not load external Google Fonts');
    }
    if (/innerHTML\s*=/.test(fs.readFileSync(path.join(targetDir, 'popup.js'), 'utf8'))) {
        errors.push('popup.js must not use innerHTML');
    }
    if (/innerHTML\s*=/.test(fs.readFileSync(path.join(targetDir, 'content.js'), 'utf8'))) {
        errors.push('content.js must not use innerHTML');
    }

    if (errors.length > 0) {
        throw new Error(`Validation failed for ${target}:\n - ${errors.join('\n - ')}`);
    }
}

function buildTarget(target) {
    const targetDir = path.join(DIST_DIR, target);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    // Copy src files
    copyDir(SRC_DIR, targetDir);

    // Copy PNG icons (exclude raw SVG from dist to keep bundle clean)
    const destIcons = path.join(targetDir, 'icons');
    fs.mkdirSync(destIcons, { recursive: true });
    for (const file of fs.readdirSync(ICONS_DIR)) {
        if (file.endsWith('.png')) {
            fs.copyFileSync(path.join(ICONS_DIR, file), path.join(destIcons, file));
        }
    }

    // Copy target manifest
    const manifestSrc = path.join(MANIFESTS_DIR, `manifest.${target}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
    fs.writeFileSync(
        path.join(targetDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n'
    );

    validateBuild(target, targetDir, manifest);

    // Package zip (store-ready archive with manifest.json at archive root)
    const zipName = `better-youtube-history-${target}-v${manifest.version}.zip`;
    const zipPath = path.join(DIST_DIR, zipName);
    fs.rmSync(zipPath, { force: true });

    execFileSync('zip', ['-r', '-q', zipPath, '.', '-x', '*.DS_Store', '__MACOSX/*'], { cwd: targetDir });

    // Verify manifest.json is strictly at the archive root (no wrapper directory)
    const zipBuf = fs.readFileSync(zipPath);
    let foundRootManifest = false;
    let idx = 0;
    while ((idx = zipBuf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), idx)) !== -1) {
        const nameLen = zipBuf.readUInt16LE(idx + 28);
        const name = zipBuf.subarray(idx + 46, idx + 46 + nameLen).toString('utf8');
        if (name === 'manifest.json') foundRootManifest = true;
        idx += 46 + nameLen;
    }
    if (!foundRootManifest) {
        throw new Error(`Archive ${zipName} does not contain manifest.json at root!`);
    }

    const sizeKB = (fs.statSync(zipPath).size / 1024).toFixed(1);
    console.log(`Built ${target}: dist/${zipName} (${sizeKB} KB)`);
}

fs.mkdirSync(DIST_DIR, { recursive: true });
buildTarget('chrome');
buildTarget('firefox');
console.log('All store builds validated and packaged successfully.');
