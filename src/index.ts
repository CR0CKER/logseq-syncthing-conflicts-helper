import '@logseq/libs';
import {createTwoFilesPatch} from 'diff';
import {settingsSchema} from "./settings";

//TODO: provide an icon (referenced in plugin.json)
const pluginName = 'syncthing-conflicts-helper';
const defaultConflictPageName = 'Syncthing Conflicts Report';

const conflictPageName = (): string => logseq.settings?.conflictPageName as string ?? defaultConflictPageName;

const count = (n: number, singular: string, plural: string = singular + 's'): string => n + ' ' + (n <= 1 ? singular : plural);

async function conflicts() {
    // Return ?orig (original-cased page name, preserves case for journals/etc.)
    // and ?path (file-system path) so we can resolve the original page by file path.
    return await logseq.DB.datascriptQuery(
        `
        [:find ?orig ?path
            :where
            [?page :block/name ?name]
            [?page :block/original-name ?orig]
            [?page :block/file ?f]
            [?f :file/path ?path]
            [(clojure.string/includes? ?name "sync-conflict-")]]
        `
    );
}

// Look up a page by the file-system path of its backing file.
// Needed because for journal pages the page name (e.g. "May 1st, 2026") differs
// from the on-disk filename stem (e.g. "2026_05_01"), so we cannot derive the
// original page name from the conflict page name by string manipulation alone.
async function findPageByFilePath(path: string): Promise<{name: string, originalName: string} | null> {
    const rows = await logseq.DB.datascriptQuery(
        `
        [:find ?name ?orig
            :in $ ?path
            :where
            [?page :block/name ?name]
            [?page :block/original-name ?orig]
            [?page :block/file ?f]
            [?f :file/path ?path]]
        `,
        JSON.stringify(path)
    );
    if (!rows || rows.length === 0) return null;
    return {name: rows[0][0], originalName: rows[0][1]};
}

function registerButton(emoji: string, title: string, onClick: () => void) {
    logseq.App.registerUIItem('toolbar', {
        // TODO: how to provide a label for the button when it is in the menu
        key: 'syncthing-conflicts',
        template: `<a class="button" data-on-click="onClick" title="${title}"> <span style="font-size: 16px;">${emoji}</span></a>`
    });
    logseq.provideModel({onClick: onClick});
}

async function content(pageName: string, ignoreCollapsed = true): Promise<string> {
    const lines: string[] = [];

    function walk(block: any, indent = 0) {
        lines.push(' '.repeat(indent) + (block.content ?? ''));
        if (block.children) {
            for (const child of block.children) walk(child, indent + 1);
        }
    }

    const blocks = await logseq.Editor.getPageBlocksTree(pageName);
    if (!blocks) return '';
    for (const block of blocks) walk(block);

    const content = lines.join('\n')
        // Prefixing each line with '| ' to ensure proper code block formatting in Logseq and not having inlined ``` breaking the blocks
        .replace(/^/gm, '| ');

    if (ignoreCollapsed) {
        return content.replace(/^\|\s*collapsed:: true\n/g, '');
    }
    return content;
}

async function updateStatus(pageName: string) {
    const files = await conflicts();
    if (files.length === 0) {
        console.log(`${pluginName}: no conflicts found.`);
        registerButton("✅", "No Conflicts", () => {
            logseq.UI.showMsg("No sync conflicts found!", "success");
        });
    } else {
        console.log(`${pluginName}: found ${files.length} conflict(s).`);
        registerButton("🚨", `View ${count(files.length, 'Conflict')}`, async () => {
            await logseq.Editor.deletePage(pageName);
            const page = await logseq.Editor.createPage(pageName, {}, {createFirstBlock: false});
            if (page) {
                const pageContent = `The following sync conflicts were found`;
                const parentBlock = await logseq.Editor.insertBlock(pageName, pageContent);
                for (const file of files) {
                    const conflictDisplayName: string = file[0];
                    const conflictFilePath: string = file[1];
                    const conflictContent = await content(conflictDisplayName);
                    // Strip the .sync-conflict-<timestamp>-<deviceid> suffix from the file path
                    // and resolve the original page via its on-disk file path. This works for
                    // journal pages, namespaced pages, and any page whose Logseq name differs
                    // from its filename stem.
                    const originalFilePath = conflictFilePath.replace(/\.sync-conflict-[^.\/]*/, "");
                    const originalPage = await findPageByFilePath(originalFilePath);
                    const originalDisplayName = originalPage?.originalName ?? conflictDisplayName.replace(/\.sync-conflict-.*/, "");
                    const originalContent = originalPage ? await content(originalPage.name) : '';
                    const diff = createTwoFilesPatch(originalDisplayName, conflictDisplayName, originalContent, conflictContent);
                    const added = diff.split('\n').filter(value => value.startsWith('+') && !value.startsWith('+++')).length;
                    const removed = diff.split('\n').filter(value => value.startsWith('-') && !value.startsWith('---')).length;
                    const fileBlock = await logseq.Editor.insertBlock(
                        parentBlock.uuid,
                        `
                        [[${originalDisplayName}]] - [[${conflictDisplayName}]] (${count(added, 'added line')}, ${count(removed, 'removed line')}) - {{{renderer syncthing-conflict-helper--mark-as-resolved, ${conflictDisplayName}}}}
                        collapsed:: true
                        `.replace(/^ */gm, ''),
                        {focus: false}
                    );
                    if (!fileBlock) continue;
                    await logseq.Editor.insertBlock(
                        fileBlock.uuid,
                        `
                        \`\`\`diff
                        ${diff}
                        \`\`\`
                        `.replace(/^ */gm, ''),
                        {focus: false}
                    );
                }
            } else {
                await logseq.UI.showMsg("Failed to create 'Sync Conflicts' page.", "error");
            }
        });
    }
}

async function execute() {
    console.log(`${pluginName}: checking for conflicts...`);
    await updateStatus(conflictPageName());
}

async function initialize() {
    logseq.useSettingsSchema(settingsSchema);

    logseq.App.onMacroRendererSlotted(({slot, payload}) => {
        const [macroName, ...args] = payload.arguments as string[];
        console.log(`${pluginName}: found ${macroName} with args: ${args.join(', ')}`);
        if (macroName !== 'syncthing-conflict-helper--mark-as-resolved') return;
        const [conflictFileName] = args;
        const key = `syncthing-conflict-helper--mark-as-resolved--${conflictFileName}`;
        const template =
            `<button
                class="ls-btn ls-btn-primary"
                title="Mark conflict as resolved and delete conflict file"
                data-on-click="markAsResolved"
                data-conflict-page="${conflictFileName}"
            >✅</button>`;
        logseq.provideUI({key, template: null, reset: true});
        logseq.provideUI({key, slot, template: template});
    });

    logseq.provideModel({
        async markAsResolved(e: any) {
            const pageName = conflictPageName();
            console.log(`${pluginName}: markAsResolved`, e);
            const conflictFileName = e?.dataset?.conflictPage;
            if (conflictFileName) {
                const page = await logseq.Editor.getPage(conflictFileName);
                if (page) {
                    await logseq.Editor.deletePage(page.name);
                    await logseq.UI.showMsg(`Conflict page '${conflictFileName}' marked as resolved and deleted.`, "success");
                    await updateStatus(pageName);
                } else {
                    await logseq.UI.showMsg(`Conflict page '${conflictFileName}' not found.`, "error");
                }
            }
        }
    })
}

async function main() {
    await initialize();
    await execute();
    setInterval(() => {
        execute();
    }, 10000);

    console.log(`${pluginName}: plugin loaded`);
}

logseq.ready(main).catch(console.error);
