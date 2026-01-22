const GAME_ID = 'astroneer';
const STEAMAPP_ID = '361420';
const XBOX_ID = '9NBLGGH43KZB';

const path = require('path');
const {
    fs,
    log,
    util,
    selectors,
    actions
} = require('vortex-api');

// Namespace
const NAMESPACE = 'game-astroneer';
const NS = 'game-astroneer';

// Notificações
const NOTIF_ID_BP_MODLOADER_DISABLED = 'notif-astroneer-bp-modloader-disabled';
const NOTIF_ID_REQUIREMENTS = 'astroneer-requirements-download-notification';
const NOTIF_ID_UE4SS_UPDATE = 'astroneer-ue4ss-version-update';

// Executáveis
const DEFAULT_EXECUTABLE = 'Astro.exe';
const XBOX_EXECUTABLE = 'gamelaunchhelper.exe';

// Caminhos
const UE4SS_PATH_PREFIX = path.join('Astro', 'Binaries');
const PAK_MODSFOLDER_PATH = path.join('Astro', 'Content', 'Paks', 'LogicMods');

// Extensões de arquivo
const LUA_EXTENSIONS = ['.lua'];
const PAK_EXTENSIONS = ['.pak'];

// Arquivos importantes
const UE4SS_ENABLED_FILE = 'enabled.txt';
const IGNORE_CONFLICTS = [UE4SS_ENABLED_FILE, 'ue4sslogicmod.info', '.ue4sslogicmod', '.logicmod'];
const IGNORE_DEPLOY = [path.join("**", "mods.json"), path.join("**", "mods.txt"), UE4SS_ENABLED_FILE];

// Arquivos UE4SS
const UE4SS_DWMAPI = 'dwmapi.dll';
const UE4SS_SETTINGS_FILE = 'UE4SS-settings.ini';
const UE4SS_3_0_1_FILES = [UE4SS_DWMAPI, UE4SS_SETTINGS_FILE];

// AutoIntegrator
const AUTOINTEGRATOR_FILES = ['ca-bundle.crt'];

// Diretórios de nível superior
const TOP_LEVEL_DIRECTORIES = ['Engine', 'Astro'];

// Tipos de mod
const MOD_TYPE_PAK = 'astroneer-pak-modtype';
const MOD_TYPE_LUA = 'astroneer-lua-modtype';
const MOD_TYPE_UE4SS = ''; // keep empty
const MOD_TYPE_AUTOINTEGRATOR = ''; // keep empty

// ==================== FUNÇÕES UTILITÁRIAS ====================temp 

function resolveUE4SSPath(api) {
    const state = api.getState();
    const discovery = selectors.discoveryByGame(state, GAME_ID);
    const architecture = discovery?.store === 'xbox' ? 'WinGDK' : 'Win64';
    return path.join(UE4SS_PATH_PREFIX, architecture, "ue4ss");
}

// returns [largerVersion, wereEqual]
function returnLargerVersion(v1, v2) {
    if (v1 == null) return [v2, false];
    if (v2 == null) return [v1, false];
    
    const v1_splitByDots = v1.toString().replace('-', '.').split('.');
    const v2_splitByDots = v2.toString().replace('-', '.').split('.');
    const numEntriesShared = Math.min(v1_splitByDots.length, v2_splitByDots.length);

    for (let i = 0; i < numEntriesShared; i++)
    {
        const v1_part = parseInt(v1_splitByDots[i]);
        const v2_part = parseInt(v2_splitByDots[i]);
        if (v1_part == NaN || v2_part == NaN) continue;
        if (v1_part != v2_part) return [v1_part > v2_part ? v1 : v2, false];
    }

    // if all checked numbers are equal but the lengths are different, return the longer one
    // with UE4SS versioning, 3.0.1 is older than 3.0.1-0 (for some reason)
    if (v1_splitByDots.length != v2_splitByDots.length) return [v1_splitByDots.length > v2_splitByDots.length ? v1 : v2, false];

    // v1 == v2, just return one
    return [v1, true];
}

async function resolveVersionByPattern(api, requirement) {
    const state = api.getState();
    const files = util.getSafe(state, ['persistent', 'downloads', 'files'], []);
    const latestVersion = Object.values(files).reduce((prev, file) => {
        const match = requirement.fileArchivePattern.exec(file.localPath);
        if (match?.[1]) prev = returnLargerVersion(match[1], prev)[0];
        return prev;
    }, '0.0.0');
    return latestVersion;
}

function getEnabledMods(api, modType) {
    const state = api.getState();
    const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
    const profileId = selectors.lastActiveProfileForGame(state, GAME_ID);
    const profile = util.getSafe(state, ['persistent', 'profiles', profileId], {});
    const isEnabled = modId => util.getSafe(profile, ['modState', modId, 'enabled'], false);

    return Object.values(mods).filter(mod =>
        isEnabled(mod.id) && (mod.type === modType || mod.type === '')
    );
}

async function findModByFile(api, modType, fileName) {
    const mods = getEnabledMods(api, modType);
    const installationPath = selectors.installPathForGame(api.getState(), GAME_ID);

    for (const mod of mods) {
        const modPath = path.join(installationPath, mod.installationPath);
        try {
            // recursive flag is necessary because of internal deployed mod directory structure
            // (otherwise this function will always just return "Astro")
            const files = await fs.readdirAsync(modPath, {recursive: true});
            if (files.some(file =>
                    path.basename(file).toLowerCase() === path.basename(fileName).toLowerCase()
                )) {
                return mod;
            }
        } catch (err) {
            // Ignorar erros
        }
    }
    return undefined;
}

function findDownloadIdByPattern(api, requirement) {
    if (!requirement.fileArchivePattern) {
        log('warn', `no fileArchivePattern defined for ${requirement.archiveFileName}`, 'findDownloadIdByPattern');
        return null;
    }

    const state = api.getState();
    const downloads = util.getSafe(state, ['persistent', 'downloads', 'files'], {});

    return Object.entries(downloads).reduce((prev, [dlId, dl]) => {
        if (!prev && requirement.fileArchivePattern) {
            const match = requirement.fileArchivePattern.exec(dl.localPath);
            if (match) prev = dlId;
        }
        return prev;
    }, null);
}

function findDownloadIdByFile(api, fileName) {
    const state = api.getState();
    const downloads = util.getSafe(state, ['persistent', 'downloads', 'files'], {});

    return Object.entries(downloads).reduce((prev, [dlId, dl]) => {
        if (path.basename(dl.localPath).toLowerCase() === fileName.toLowerCase()) {
            prev = dlId;
        }
        return prev;
    }, '');
}

async function findInstallFolderByFile(api, filePath) {
    const installationPath = selectors.installPathForGame(api.getState(), GAME_ID);
    try {
        const pathContents = await fs.readdirAsync(installationPath);
        const modFolders = pathContents.filter(folder =>
            path.extname(folder) === '.installing'
        );

        if (modFolders.length === 1) {
            return path.join(installationPath, modFolders[0]);
        }

        for (const folder of modFolders) {
            const modPath = path.join(installationPath, folder);
            try {
                const files = await fs.readdirAsync(modPath);
                if (files.find(file => file.endsWith(filePath))) {
                    return path.join(installationPath, folder);
                }
            } catch (err) {
                // Continuar
            }
        }
    } catch (err) {
        // Ignorar erro
    }
    return undefined;
}

async function walkPath(dirPath, walkOptions = {}) {
    const options = {
        skipLinks: true,
        skipHidden: true,
        skipInaccessible: true,
        ...walkOptions
    };

    const walkResults = [];
    try {
        const entries = await fs.readdirAsync(dirPath);
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry);
            try {
                const stat = await fs.statAsync(fullPath);
                if (stat.isDirectory()) {
                    const subEntries = await walkPath(fullPath, options);
                    walkResults.push(...subEntries);
                } else {
                    walkResults.push({
                        filePath: fullPath
                    });
                }
            } catch (err) {
                // Ignorar entrada inacessível
            }
        }
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    return walkResults;
}

async function runStagingOperationOnMod(api, modId, func) {
    try {
        await api.emitAndAwait('deploy-single-mod', GAME_ID, modId, false);
        await func(api, modId);
        await api.emitAndAwait('deploy-single-mod', GAME_ID, modId);
    } catch (err) {
        api.showErrorNotification('Failed to run staging operation', err);
    }
}

function dismissNotifications(api) {
    [NOTIF_ID_BP_MODLOADER_DISABLED, NOTIF_ID_UE4SS_UPDATE].forEach(id =>
        api.dismissNotification(id)
    );
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// ==================== REQUISITOS DO PLUGIN ====================

const PLUGIN_REQUIREMENTS = [{
        modType: MOD_TYPE_UE4SS,
        assemblyFileName: UE4SS_DWMAPI,
        userFacingName: "UE4SS",
        githubUrl: "https://api.github.com/repos/atenfyr/RE-UE4SS",
        findMod: api => findModByFile(api, "", UE4SS_SETTINGS_FILE),
        findDownloadId: api => findDownloadIdByPattern(api, PLUGIN_REQUIREMENTS[0]),
        fileArchivePattern: new RegExp(/^UE4SS.*v(\d+\.\d+\.\d+(?:-\d+)?)/, "i"),
        resolveVersion: api => resolveVersionByPattern(api, PLUGIN_REQUIREMENTS[0])
    },
    {
        modType: MOD_TYPE_AUTOINTEGRATOR,
        userFacingName: "AutoIntegrator",
        githubUrl: "https://api.github.com/repos/atenfyr/AutoIntegrator",
        findMod: api => findModByFile(api, "", AUTOINTEGRATOR_FILES[0]),
        findDownloadId: api => findDownloadIdByPattern(api, PLUGIN_REQUIREMENTS[1]),
        fileArchivePattern: new RegExp(/^atenfyr-AutoIntegrator-(\d+\.\d+\.\d+)/, "i"),
        resolveVersion: api => resolveVersionByPattern(api, PLUGIN_REQUIREMENTS[1])
    }
];

// ==================== FUNÇÕES DE TIPOS DE MOD ====================

function getPakPath(api, game) {
    const discovery = selectors.discoveryByGame(api.getState(), game.id);
    if (!discovery || !discovery.path) return '.';
    return path.join(discovery.path, PAK_MODSFOLDER_PATH);
}

function testPakPath(api, instructions) {
    if (instructions.some(instr => instr.type === 'setmodtype')) {
        return Promise.resolve(false);
    }

    const filtered = instructions.filter(inst =>
        inst.type === 'copy' &&
        PAK_EXTENSIONS.includes(path.extname(inst.source))
    );

    return Promise.resolve(filtered.length > 0);
}

function getLUAPath(api, game) {
    const discovery = selectors.discoveryByGame(api.getState(), game.id);
    if (!discovery || !discovery.path) return '.';
    const ue4ssPath = resolveUE4SSPath(api);
    return path.join(discovery.path, ue4ssPath, "Mods");
}

function testLUAPath(api, instructions) {
    if (instructions.some(instr => instr.type === 'setmodtype')) {
        return Promise.resolve(false);
    }

    const filtered = instructions.filter(inst =>
        inst.type === 'copy' &&
        LUA_EXTENSIONS.includes(path.extname(inst.source))
    );

    return Promise.resolve(filtered.length > 0);
}

// ==================== INSTALADORES ====================

async function testUE4SSInjector(files, gameId) {
    const supported = gameId === GAME_ID &&
        files.some(file => path.basename(file).toLowerCase() === UE4SS_SETTINGS_FILE.toLowerCase());
    return {
        supported,
        requiredFiles: []
    };
}

async function installUE4SSInjector(api, files, destinationPath, gameId) {
    const state = api.getState();
    const discovery = selectors.discoveryByGame(state, gameId);
    const gameStore = discovery?.store || 'steam';
    const architecture = gameStore === 'xbox' ? 'WinGDK' : 'Win64';
    const expectedInstallDir = path.basename(destinationPath, '.installing');
    const version = PLUGIN_REQUIREMENTS[0].fileArchivePattern.exec(expectedInstallDir);
    
    const versionAttrib = {
        type: 'attribute',
        key: 'version',
        value: version ? version[1] : 'unknown'
    };
    
    const targetPath = path.join(UE4SS_PATH_PREFIX, architecture);
    const instructions = [versionAttrib];
    
    for (const iter of files) {
        const segments = iter.split(path.sep);
        if (path.extname(segments[segments.length - 1]) !== '') {
            let destination = path.join(targetPath, iter);

            // we no longer override UE4SS settings ini
            // AutoIntegrator does that job for us, and failing that, corrected ini is already distributed with atenfyr/RE-UE4SS repository
            
            instructions.push({
                type: 'copy',
                source: iter,
                destination
            });
        }
    }
    
    instructions.push({
        type: 'setmodtype',
        value: MOD_TYPE_UE4SS
    });
    
    return { instructions };
}

async function testLuaMod(files, gameId) {
    const rightGame = gameId === GAME_ID;
    const rightFile = files.some(file => LUA_EXTENSIONS.includes(path.extname(file)));
    return {
        supported: rightGame && rightFile,
        requiredFiles: []
    };
}

async function installLuaMod(api, files, destinationPath, gameId) {
    const luaFiles = files.filter(file => LUA_EXTENSIONS.includes(path.extname(file)));
    luaFiles.sort((a, b) => a.length - b.length);

    const shortest = luaFiles[0] || files[0];
    const segments = shortest ? shortest.split(path.sep) : [];
    const modsSegmentIdx = segments.map(seg => seg?.toLowerCase()).indexOf('mods');
    const folderId = modsSegmentIdx !== -1 ? segments[modsSegmentIdx + 1] :
        segments.length > 1 ? segments[0] :
        path.basename(destinationPath, '.installing');

    const attrInstr = {
        type: 'attribute',
        key: 'astroneerFolderId',
        value: folderId
    };

    const instructions = [attrInstr];

    for (const iter of files) {
        if (iter.endsWith(path.sep) || path.extname(iter) === '') continue;

        const fileSegments = iter.split(path.sep);
        let destination;

        // deliberately slice here to not include Mods in the final path
        if (modsSegmentIdx !== -1) {
            destination = path.join(fileSegments.slice(modsSegmentIdx + 1).join(path.sep));
        } else if (fileSegments.length > 1) {
            destination = path.join(folderId, fileSegments.slice(1).join(path.sep));
        } else {
            destination = path.join(folderId, iter);
        }

        instructions.push({
            type: 'copy',
            source: iter,
            destination
        });
    }

    instructions.push({
        type: 'setmodtype',
        value: MOD_TYPE_LUA
    });

    return {
        instructions
    };
}

async function testAutoIntegrator(files, gameId) {
    const supported = gameId === GAME_ID &&
        files.some(file => path.basename(file).toLowerCase() === AUTOINTEGRATOR_FILES[0].toLowerCase());
    return {
        supported,
        requiredFiles: []
    };
}

async function installAutoIntegrator(api, files, destinationPath, gameId) {
    const state = api.getState();
    const discovery = selectors.discoveryByGame(state, gameId);
    const gameStore = discovery?.store || 'steam';
    const architecture = gameStore === 'xbox' ? 'WinGDK' : 'Win64';
    const expectedInstallDir = path.basename(destinationPath, '.installing');
    const version = PLUGIN_REQUIREMENTS[1].fileArchivePattern.exec(expectedInstallDir);

    const versionAttrib = {
        type: 'attribute',
        key: 'version',
        value: version ? version[1] : 'unknown'
    };

    const targetPath = path.join(resolveUE4SSPath(api), "Mods", "AutoIntegrator");
    const instructions = [versionAttrib];

    for (const iter of files) {
        let segments = iter.split(path.sep);
        const extname = path.extname(segments[segments.length - 1]);
        const firstDir = segments.shift();
        if (extname !== '' && firstDir == "mod") {
            let destination = path.join(targetPath, segments.join(path.sep));

            instructions.push({
                type: 'copy',
                source: iter,
                destination
            });
        }
    }

    instructions.push({
        type: 'setmodtype',
        value: MOD_TYPE_AUTOINTEGRATOR
    });

    return {
        instructions
    };
}

// ==================== FUNÇÃO MAIN ====================

function getExecutable(discoveryPath) {
    const isCorrectExec = (exec) => {
        try {
            fs.statSync(path.join(discoveryPath, exec));
            return true;
        } catch (err) {
            return false;
        }
    };

    if (!discoveryPath) return DEFAULT_EXECUTABLE;

    if (isCorrectExec(XBOX_EXECUTABLE)) {
        return XBOX_EXECUTABLE;
    }

    if (isCorrectExec(DEFAULT_EXECUTABLE)) {
        return DEFAULT_EXECUTABLE;
    }

    return DEFAULT_EXECUTABLE;
}

function getStopPatterns(escape = false) {
    const dirToWordExp = (input) => {
        return escape ? `(^|/)${input}(/|$)` : `(^|/)${input}(/|$)`;
    };

    const extToWordExp = (input) => {
        return escape ? `[^/]*\\${input}$` : `[^/]*\\${input}$`;
    };

    const pakFilePatterns = PAK_EXTENSIONS.map(val => extToWordExp(val.toLowerCase()));
    const luaFilePatterns = LUA_EXTENSIONS.map(val => extToWordExp(val.toLowerCase()));
    const luaFolderPatterns = ['scripts'].map(val => dirToWordExp(val.toLowerCase()));
    const topLevelDirs = TOP_LEVEL_DIRECTORIES.map(val => dirToWordExp(val.toLowerCase()));

    return [...topLevelDirs, ...pakFilePatterns, ...luaFolderPatterns, ...luaFilePatterns];
}

function getTopLevelPatterns(escape = false) {
    const dirToWordExp = (input) => {
        return escape ? `(^|/)${input}(/|$)` : `(^|/)${input}(/|$)`;
    };

    return TOP_LEVEL_DIRECTORIES.map(val => dirToWordExp(val.toLowerCase()));
}

async function getLatestGithubReleaseAsset(api, requirement, preRelease = true) {
    const chooseAsset = (release) => {
        var _a;
        const assets = release.assets;
        if (!!requirement.fileArchivePattern) {
            const asset = assets.find(asset => requirement.fileArchivePattern.exec(asset.name));
            if (asset) {
                return {
                    ...asset,
                    release,
                };
            }
        } else {
            const asset = (_a = assets.find((asset) => asset.name.includes(requirement.archiveFileName))) !== null && _a !== void 0 ? _a : assets[0];
            return {
                ...asset,
                release,
            };
        }
        return null; // Adicionar retorno padrão
    };

    try {
        const response = await fetch(`${requirement.githubUrl}/releases`);
        const resHeaders = response.headers;
        const callsRemaining = parseInt(util.getSafe(resHeaders, ['x-ratelimit-remaining'], '0'), 10);

        if ([403, 404].includes(response?.status) && (callsRemaining === 0)) {
            const resetDate = parseInt(util.getSafe(resHeaders, ['x-ratelimit-reset'], '0'), 10);
            log('info', 'GitHub rate limit exceeded', {
                reset_at: (new Date(resetDate * 1000)).toString()
            });
            return Promise.reject(new util.ProcessCanceled('GitHub rate limit exceeded'));
        }

        if (response.status === 200) {
            const data = await response.json(); // Correção: usar await
            const releases = data.filter((release) => preRelease || !release.prerelease);
            if (releases.length > 0 && releases[0].assets.length > 0) {
                return chooseAsset(releases[0]);
            }
        }
        return null; // Retornar null se não encontrar
    } catch (error) {
        api.showErrorNotification('Error fetching the latest release url for {{repName}}', error, {
            allowReport: false,
            replace: {
                repName: requirement.archiveFileName || requirement.userFacingName
            }
        });
        return null;
    }
}
async function installDownload(api, dlId, name) {
    return new Promise((resolve, reject) => {
        api.events.emit('start-install-download', dlId, {
            allowAutoEnable: true,
            unattended: true,
            choices: {
                action: 'replace'
            }
        }, (err, modId) => {
            if (err !== null) {
                api.showErrorNotification('Failed to install requirement', err, {
                    allowReport: false
                });
                return reject(err);
            }
            const state = api.getState();
            const profileId = selectors.lastActiveProfileForGame(state, GAME_ID);
            const batch = [
                actions.setModAttributes(GAME_ID, modId, {
                    installTime: new Date(),
                    name,
                }),
                actions.setModEnabled(profileId, modId, true),
            ];
            util.batchDispatch(api.store, batch);
            return resolve();
        });
    });
}
async function importAndInstall(api, filePath, name) {
    return new Promise((resolve, reject) => {
        api.events.emit('import-downloads', [filePath], async (dlIds) => {
            const id = dlIds[0];
            if (id === undefined) {
                return reject(new util.NotFound(filePath));
            }
            const batched = [];
            batched.push(actions.setDownloadModInfo(id, 'source', 'other'));
            util.batchDispatch(api.store, batched);
            try {
                await installDownload(api, id, name);
                return resolve();
            } catch (err) {
                return reject(err);
            }
        });
    });
}
async function removeExistingReq(api, requirement) {
    return new Promise(async (resolve, reject) => {
        const mod = await requirement.findMod(api);
        if (!mod) {
            return resolve();
        }
        api.events.emit('remove-mods', GAME_ID, [mod.id], (err) => {
            if (err !== null) {
                return reject(err);
            } else {
                return resolve();
            }
        });
    });
}
async function doDownload(downloadUrl, destination) {
    const response = await fetch(downloadUrl, {
        headers: {
            "Accept-Encoding": "gzip, deflate",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36"
        },
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const resHeaders = Object.fromEntries(response.headers.entries());
    const callsRemaining = parseInt(util.getSafe(resHeaders, ['x-ratelimit-remaining'], '0'), 10);

    if ([403, 404].includes(response.status) && (callsRemaining === 0)) {
        const resetDate = parseInt(util.getSafe(resHeaders, ['x-ratelimit-reset'], '0'), 10);
        log('info', 'GitHub rate limit exceeded', {
            reset_at: (new Date(resetDate * 1000)).toString()
        });
        return Promise.reject(new util.ProcessCanceled('GitHub rate limit exceeded'));
    }

    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFileAsync(destination, Buffer.from(arrayBuffer));
}
async function download(api, requirements, force) {
    api.sendNotification({
        id: NOTIF_ID_REQUIREMENTS,
        message: 'Installing Astroneer Requirements',
        type: 'activity',
        noDismiss: true,
        allowSuppress: false,
    });
    const batchActions = [];
    const profileId = selectors.lastActiveProfileForGame(api.getState(), GAME_ID);
    try {
        for (const req of requirements) {
            let versionMismatch = false;
            const asset = await getLatestGithubReleaseAsset(api, req);
            if (!asset) {
                api.showErrorNotification(`Failed to get ${req.userFacingName}`,
                    new Error('Could not fetch release from GitHub'));
                continue; // Pular para o próximo requirement
            }
            const versionMatch = !!req.fileArchivePattern ? req.fileArchivePattern.exec(asset.name) : [asset.name, asset.release.tag_name];
            const latestVersion = versionMatch[1];
            const mod = await req.findMod(api);
            if (!!mod && req.resolveVersion && force !== true) {
                const version = await req.resolveVersion(api);

                const comparisonResults = returnLargerVersion(latestVersion, version);
                if (!comparisonResults[1]) {
                    versionMismatch = true;
                    batchActions.push(actions.setModEnabled(profileId, mod.id, false));
                } else {
                    continue;
                }
            } else if (!versionMismatch && force !== true && (mod === null || mod === void 0 ? void 0 : mod.id) !== undefined) {
                batchActions.push(actions.setModEnabled(profileId, mod.id, true));
                batchActions.push(actions.setModAttributes(GAME_ID, mod.id, {
                    customFileName: req.userFacingName,
                    version: latestVersion,
                    description: 'This is an Astroneer modding requirement - leave it enabled.',
                }));
                continue;
            }
            if ((req === null || req === void 0 ? void 0 : req.modId) !== undefined) {
                //await downloadNexus(api, req);
            } else {
                const dlId = req.findDownloadId(api);
                if (!versionMismatch && !force && dlId) {
                    await installDownload(api, dlId, req.userFacingName);
                    continue;
                }
                const tempPath = path.join(util.getVortexPath('temp'), asset.name);
                try {
                    if (force && !!mod) {
                        await removeExistingReq(api, req);
                    }
                    if (asset && asset.browser_download_url) {
                        await doDownload(asset.browser_download_url, tempPath);
                    } else {
                        throw new Error('Asset not found');
                    }
                    await importAndInstall(api, tempPath, req.userFacingName);
                } catch (err) {
                    api.showErrorNotification('Failed to download requirements', err, {
                        allowReport: false
                    });
                    return;
                }
            }
        }
    } finally {
        if (batchActions.length > 0) {
            util.batchDispatch(api.store, batchActions);
        }
        api.dismissNotification(NOTIF_ID_REQUIREMENTS);
    }
}

// update mods.txt
async function updateModsTxt(api) {
    const state = api.getState();
    const discovery = selectors.discoveryByGame(state, GAME_ID);
    if (!discovery || !discovery.path) return;
    const modsPath = path.join(discovery.path, resolveUE4SSPath(api), "Mods");

    try {
        await fs.mkdirAsync(modsPath, {
            recursive: true
        });
    } catch {
        // no big deal
    }

    try {
        const allModNames = await fs.readdirAsync(modsPath, {
                withFileTypes: true
            })
            .filter(d => d.isDirectory())
            .map(d => d.name);

        let modsTxtData = "";
        for (let i = 0; i < allModNames.length; i++) modsTxtData += allModNames[i] + " : 1\n";

        await fs.writeFileAsync(path.join(modsPath, "mods.txt"), modsTxtData, "utf8");
    } catch {
        (0, log)('error', 'failed to update mods.txt', err);
    }
}

async function onModsEnabled(api, modIds, enabled, gameId) {
    if (gameId !== GAME_ID) return;
    await updateModsTxt(api);
}

async function onModsRemoved(api, gameId, modIds) {
    if (gameId !== GAME_ID) return;
    await updateModsTxt(api);
}

async function onDidDeployEvent(api, profileId, deployment) {
    const state = api.getState();
    const profile = selectors.profileById(state, profileId);
    const gameId = profile === null || profile === void 0 ? void 0 : profile.gameId;

    if (gameId !== GAME_ID) return;
    await updateModsTxt(api);
    return Promise.resolve();
}

async function onDidPurgeEvent(api, profileId) {
    const state = api.getState();
    const profile = selectors.profileById(state, profileId);
    const gameId = profile === null || profile === void 0 ? void 0 : profile.gameId;

    if (gameId !== GAME_ID) return;
    await updateModsTxt(api);
    return Promise.resolve();
}

async function setup(api, discovery) {
    if (!discovery || !discovery.path) return;

    const ensurePath = (filePath) =>
        fs.ensureDirWritableAsync(path.join(discovery.path, filePath));

    try {
        const UE4SSPath = resolveUE4SSPath(api);

        await Promise.all([
            path.join(UE4SSPath, 'Mods'),
            PAK_MODSFOLDER_PATH
        ].map(ensurePath));

        // Não vamos forçar download automático
        await download(api, PLUGIN_REQUIREMENTS, false);

    } catch (err) {
        api.showErrorNotification('Failed to setup ASTRONEER extension', err);
    }
}

async function requiresLauncher(gamePath, store) {
    if (store === 'xbox') {
        return Promise.resolve({
            launcher: 'xbox',
            addInfo: {
                appId: XBOX_ID,
                parameters: [{
                    appExecName: 'AppSystemEraSoftworks29415440E1269Shipping'
                }]
            }
        });
    }
    return Promise.resolve(undefined);
}

function main(context) {
    context.registerGame({
        id: GAME_ID,
        name: 'ASTRONEER',
        mergeMods: true,
        queryPath: async () => {
            const game = await util.GameStoreHelper.findByAppId([STEAMAPP_ID, XBOX_ID]);
            return game?.gamePath || null;
        },
        queryArgs: {
            steam: [{
                id: STEAMAPP_ID,
                prefer: 0
            }],
            xbox: [{
                id: XBOX_ID
            }]
        },
        queryModPath: () => '.',
        logo: 'gameart.png',
        executable: discovery => getExecutable(discovery?.path),
        requiredFiles: ["Astro/Content/Paks"],
        setup: discovery => setup(context.api, discovery),
        supportedTools: [],
        requiresLauncher,
        details: {
            customOpenModsPath: PAK_MODSFOLDER_PATH,
            supportsSymlinks: true,
            steamAppId: parseInt(STEAMAPP_ID, 10),
            stopPatterns: getStopPatterns(),
            ignoreDeploy: IGNORE_DEPLOY,
            ignoreConflicts: IGNORE_CONFLICTS
        }
    });

    // Ações
    context.registerAction('mod-icons', 300, 'open-ext', {}, 'Open Lua Mods Folder', () => {
        const state = context.api.getState();
        const discovery = selectors.discoveryByGame(state, GAME_ID);
        if (discovery?.path) {
            const ue4ssPath = resolveUE4SSPath(context.api);
            const openPath = path.join(discovery.path, ue4ssPath, 'Mods');
            util.opn(openPath).catch(() => null);
        }
    }, () => {
        const state = context.api.getState();
        return selectors.activeGameId(state) === GAME_ID;
    });

    // Instaladores
    context.registerInstaller('astroneer-ue4ss', 25, testUE4SSInjector,
        (files, destinationPath, gameId) => installUE4SSInjector(context.api, files, destinationPath, gameId));

    context.registerInstaller('astroneer-autointegrator', 30, testAutoIntegrator,
        (files, destinationPath, gameId) => installAutoIntegrator(context.api, files, destinationPath, gameId));

    context.registerInstaller('astroneer-lua-installer', 45, testLuaMod,
        (files, destinationPath, gameId) => installLuaMod(context.api, files, destinationPath, gameId));

    // Tipos de Mod
    context.registerModType(MOD_TYPE_PAK, 10,
        gameId => GAME_ID === gameId,
        game => getPakPath(context.api, game),
        instructions => testPakPath(context.api, instructions), {
            deploymentEssential: true,
            name: '.pak Mod'
        }
    );

    context.registerModType(MOD_TYPE_LUA, 9,
        gameId => GAME_ID === gameId,
        game => getLUAPath(context.api, game),
        instructions => testLUAPath(context.api, instructions), {
            deploymentEssential: true,
            name: '.lua Mod'
        }
    );

    context.once(() => {
        context.api.events.on('mods-enabled', async (modIds, enabled, gameId) => onModsEnabled(context.api, modIds, enabled, gameId));
        context.api.onAsync('did-remove-mods', async (gameId, modIds) => onModsRemoved(context.api, gameId, modIds));
        context.api.onAsync('did-deploy', (profileId, deployment) => onDidDeployEvent(context.api, profileId, deployment));
        context.api.onAsync('did-purge', (profileId) => onDidPurgeEvent(context.api, profileId));
    });

    return true;
}

module.exports = {
    default: main
};