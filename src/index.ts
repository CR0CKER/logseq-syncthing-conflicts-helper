import '@logseq/libs';
import {createTwoFilesPatch} from 'diff';
import {settingsSchema} from "./settings";

const pluginName = 'syncthing-conflicts-helper';

// Lucide check-circle-2 — MIT license (lucide.dev)
const ICON_OK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;
// Lucide alert-circle — MIT license (lucide.dev)
const ICON_ALERT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;
const defaultConflictPageName = 'Syncthing Conflicts Report';

const conflictPageName = (): string => logseq.settings?.conflictPageName as string ?? defaultConflictPageName;

const count = (n: number, singular: string, plural: string = singular + 's'): string => n + ' ' + (n <= 1 ? singular : plural);

async function conflicts() {
    return await logseq.DB.datascriptQuery(
        `
        [:find ?name ?page
            :where
            [?page :block/name ?name]
            [?page :block/file ?f]     ;; <-- only pages that live in a file
            [(clojure.string/includes? ?name "sync-conflict-")]]
        `
    );
}

function registerButton(svg: string, title: string, onClick: () => void) {
    logseq.App.registerUIItem('toolbar', {
        key: 'syncthing-conflicts',
        template: `<a class="button syncthing-conflicts-btn" data-on-click="onClick" title="${title}">${svg}</a>`
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
        registerButton(ICON_OK, "No Conflicts", () => {
            logseq.UI.showMsg("No sync conflicts found!", "success");
        });
    } else {
        console.log(`${pluginName}: found ${files.length} conflict(s).`);
        registerButton(ICON_ALERT, `View ${count(files.length, 'Conflict')}`, async () => {
            await logseq.Editor.deletePage(pageName);
            const page = await logseq.Editor.createPage(pageName, {}, {createFirstBlock: false});
            if (page) {
                const pageContent = `The following sync conflicts were found`;
                const parentBlock = await logseq.Editor.insertBlock(pageName, pageContent);
                for (const file of files) {
                    const conflictFileName = file[0];
                    const conflictContent = await content(conflictFileName);
                    const originalFileName = conflictFileName.replace(/\.sync-conflict-.*/, "");
                    const originalContent = await content(originalFileName);
                    const diff = createTwoFilesPatch(originalFileName, conflictFileName, originalContent, conflictContent);
                    const added = diff.split('\n').filter(value => value.startsWith('+') && !value.startsWith('+++')).length;
                    const removed = diff.split('\n').filter(value => value.startsWith('-') && !value.startsWith('---')).length;
                    const fileBlock = await logseq.Editor.insertBlock(
                        parentBlock.uuid,
                        `
                        [[${originalFileName}]] - [[${conflictFileName}]] (${count(added, 'added line')}, ${count(removed, 'removed line')}) - {{{renderer syncthing-conflict-helper--mark-as-resolved, ${conflictFileName}}}}
                        collapsed:: true
                        `.replace(/^ */gm, ''),
                        {focus: false}
                    );
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

    logseq.provideStyle(`
      .syncthing-conflicts-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--ls-header-button-background);
      }
    `);

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
