import assert from 'node:assert/strict'
import { checkInvariants, projectFiles } from './invariant-lint.mjs'

const files = projectFiles()
const cases = [
  ['AWB001', 'src/renderer/TerminalPane.tsx', '.onBinary(', '.onMissingBinary('],
  ['AWB002', 'src/renderer/TerminalPane.tsx', 'lineHeight: 1,', 'lineHeight: 1.45,'],
  ['AWB003', 'src/renderer/Workspace.tsx', 'const terms = tabs.filter', 'const terms = mine.filter'],
  ['AWB004', 'src/renderer/Workspace.tsx', '<main className="center" id="center">', '<main className="center" id="center"><kbd>Ctrl T</kbd>'],
  ['AWB005', 'src/renderer/MarkdownEditor.tsx', "import { useEffect", "import fs from 'node:fs'\nimport { useEffect"],
  ['AWB006', 'src/main/pty.ts', 'await session.dispose()', 'void session.dispose()'],
  ['AWB006', 'src/main/pty.ts', 'this.processExit!.then', 'Promise.resolve().then'],
  ['AWB007', 'src/main/pty.ts', "Buffer.from(data, 'latin1')", "Buffer.from(data, 'utf8')"],
  ['AWB008', 'src/main/index.ts', 'const closing = win', 'const closing = win; closing?.destroy()'],
  ['AWB009', 'src/main/index.ts', 'return publicHost({ ...host, color: hostColor(host.color) })', 'return host'],
  ['AWB010', 'src/shared/types.ts', "{ id: 'pi',", "{ id: 'gemini',"],
  ['AWB010', 'src/shared/types.ts', "{ id: 'omp',", "{ id: 'unsupported',"],
  ['AWB011', 'src/main/git.ts', "fileTree(target: Target, rel = '', ignored: ReadonlySet<string> = IGNORE): Promise<TreeNode[]> {", "fileTree(target: Target, rel = '', ignored: ReadonlySet<string> = IGNORE, depth = 0): Promise<TreeNode[]> { if (depth > 5) return []"],
  ['AWB012', 'src/main/git.ts', 'versionOf(current) !== version', 'false'],
  ['AWB013', 'src/renderer/RightPanel.tsx', 'onPointerMove=', 'onMouseMove='],
  ['AWB014', 'src/renderer/App.tsx', '{ ...latest, ...saved, draft,', '{ ...saved, draft,'],
  ['AWB015', 'src/renderer/styles/extra.css', '.termhost {', '.termhost { padding: 12px;'],
  ['AWB047', 'src/renderer/styles/extra.css', 'overflow: clip;', 'overflow: hidden;'],
  ['AWB048', 'src/main/pty.ts', "PI_HARDWARE_CURSOR: '1'", "PI_HARDWARE_CURSOR: '0'"],
  ['AWB049', 'src/main/app-icon.ts', "createHash('sha256')", "createHash('md5')"],
  ['AWB018', 'package.json', 'node scripts/terminal-input-check.mjs', 'echo skipped'],
  ['AWB016', 'src/renderer/styles/workbench.css', 'flex:0 1 auto', 'flex:1 1 auto'],
  ['AWB016', 'src/renderer/styles/workbench.css', 'height:32px;gap:2px;margin-bottom:0', 'height:32px;gap:2px;margin-bottom:5px'],
  ['AWB017', 'src/renderer/styles/workbench.css', '.dot.terminal-status.busy{background:var(--amber)}', '.dot.terminal-status.busy{background:var(--green)}'],
  ['AWB018', 'package.json', 'node scripts/workspace-check.mjs', 'echo skipped'],
  ['AWB019', 'AGENTS.md', 'npm run check', 'npx skipped'],
  ['AWB020', 'src/main/ssh.ts', 'hostVerifier:', 'missingVerifier:'],
  ['AWB021', 'src/main/preview.ts', "server.listen(0, '127.0.0.1'", "server.listen(0, '0.0.0.0'"],
  ['AWB022', 'src/renderer/App.tsx', 'savingDocuments.current.has(key)', "savingDocuments.current.has('unrelated')"],
  ['AWB023', 'src/renderer/MarkdownEditor.tsx', '!interacted.current', 'false'],
  ['AWB024', 'src/main/preview.ts', '!/\\.html?$/i.test(rel)', '!/./.test(rel)'],
  ['AWB025', 'src/renderer/documents.ts', '120_000', '800'],
  ['AWB026', 'src/renderer/FilePane.tsx', 'sandbox="allow-scripts"', 'sandbox="allow-scripts allow-same-origin"'],
  ['AWB027', 'src/renderer/ResourceSettings.tsx', '<b className="resource-name">{item.name}</b>', '<b className="resource-name">{item.name}</b><small>{item.path}</small>'],
  ['AWB028', 'src/renderer/ResourceDialog.tsx', 'dialog.showModal()', 'dialog.show()'],
  ['AWB028', 'src/renderer/ResourceDialog.tsx', 'onPointerUp=', 'onPointerMove='],
  ['AWB033', 'src/main/index.ts', 'resources.skillDirectory(targets(), agent, item, true)', 'resources.skillDirectory(targets(), agent, item, false)'],
  ['AWB029', 'src/renderer/TerminalPane.tsx', 'document.fonts.load(font)', 'Promise.resolve([])'],
  ['AWB030', 'src/renderer/FilePane.tsx', 'key={preview.url}', 'key={path}'],
  ['AWB031', 'src/main/platform.ts', '. "$HOME/.bashrc"', '# skip user startup'],
  ['AWB032', 'src/main/ssh.ts', "stream.setEncoding('utf8')", "stream.setEncoding('ascii')"],
  ['AWB034', 'src/renderer/Workspace.tsx', 'sessionOf(tab) === sessionId', 'true'],
  ['AWB035', 'src/renderer/styles/extra.css', 'animation:terminal-spin .85s linear infinite', 'animation:none'],
  ['AWB036', 'src/main/pty.ts', 'this.programStatus.push(chunk)', '{ text: chunk, queries: 0, states: [] }'],
  ['AWB037', 'src/main/index.ts', 'automatic: !keepBoth', 'automatic: false'],
  ['AWB038', 'src/renderer/UploadStatus.tsx', '{message}</span>', '{message}{task.destination}</span>'],
  ['AWB038', 'src/renderer/UploadStatus.tsx', 'TRANSFER_SUCCESS_DURATION = 2000', 'TRANSFER_SUCCESS_DURATION = 10000'],
  ['AWB038', 'src/renderer/UploadStatus.tsx', '!task.warnings?.length', 'true'],
  ['AWB038', 'src/renderer/App.tsx', '), TRANSFER_SUCCESS_DURATION)', '), 20000)'],
  ['AWB104', 'src/renderer/UploadStatus.tsx', '<FileOperationDialog title={t("传输详情")}', '<div title={t("传输详情")}'],
  ['AWB104', 'src/renderer/UploadStatus.tsx', 'className="transfer-error-details"', 'className="transfer-details"'],
  ['AWB039', 'src/main/pty.ts', "report.protocol === 'progress' && this.nativeStatus", 'false'],
  ['AWB039', 'src/main/pty.ts', "PI_PROGRAM_STATUS: '1'", "PI_PROGRAM_STATUS: '0'"],
  ['AWB040', 'src/renderer/terminal-layout.ts', 'tiles.length >= 4', 'tiles.length >= 8'],
  ['AWB040', 'src/renderer/ProjectSidebar.tsx', 'activeAgentKind(term)', 'true'],
  ['AWB041', 'src/main/temporary-sessions.ts', 'path.isAbsolute(configured)', 'true'],
  ['AWB042', 'src/renderer/Workspace.tsx', 'visible={workspaceVisible && visible}', 'visible={visible}'],
  ['AWB042', 'src/renderer/TerminalPane.tsx', 'scrollToLine(saved.viewport)', 'scrollToBottom()'],
  ['AWB043', 'src/renderer/App.tsx', "function openFile(rel: string, anchor?: string, location?: import('../shared/types').SearchLocation) {", "function openFile(rel: string, anchor?: string, location?: import('../shared/types').SearchLocation) { const pinned = false;"],
  ['AWB044', 'src/renderer/styles/markdown.css', '.markdown-outline{position:absolute;', '.markdown-outline{position:sticky;'],
  ['AWB044', 'src/renderer/ProjectSidebar.tsx', "onProjectAction(project.id, 'reveal')", 'onCreateEntry(project.id, false)'],
  ['AWB045', 'src/renderer/MarkdownEditor.tsx', 'view.nodeDOM(position)', "root.querySelector('h1')"],
  ['AWB045', 'src/renderer/styles/markdown.css', 'height:var(--pello-code-height,auto)', 'height:auto'],
  ['AWB045', 'src/renderer/styles/markdown.css', '.cm-activeLine{background:transparent}', '.cm-activeLine{background:var(--hover)}'],
  ['AWB046', 'src/main/diagram-renderer.ts', 'show: false', 'show: true'],
  ['AWB046', 'src/main/diagram-renderer.ts', 'nodeIntegration: false', 'nodeIntegration: true'],
  ['AWB046', 'src/main/diagram-renderer.ts', 'source.length > 100_000', 'false'],
  ['AWB046', 'src/renderer/diagram-renderer.ts', "securityLevel: 'strict'", "securityLevel: 'loose'"],
  ['AWB050', 'src/renderer/App.tsx', 'prependTermHistory(id, entry.text)', "prependTermHistory(id, '')"],
  ['AWB051', 'src/renderer/terms.ts', 'window.awb.saveTerminalHistory(id, text)', 'void 0'],
  ['AWB052', 'src/main/index.ts', "!node.name.startsWith('.')", 'true'],
  ['AWB053', 'src/renderer/RightPanel.tsx', 'data-a="file-search"', 'data-a="search-hidden"'],
  ['AWB054', 'src/renderer/ProjectSidebar.tsx', 'Number(!!b.project.pinned) - Number(!!a.project.pinned)', '0'],
  ['AWB055', 'src/main/pty.ts', 'session.disposeRoot()', 'session.dispose()'],
  ['AWB056', 'src/renderer/SplitDiffEditor.tsx', 'target.scrollDOM.scrollLeft = source.scrollDOM.scrollLeft', 'void target'],
  ['AWB056', 'src/renderer/SplitDiffEditor.tsx', "revertControls: 'a-to-b'", "revertControls: undefined"],
  ['AWB057', 'src/main/agent-resume.ts', '--session-dir ${directory} --continue', '--continue'],
  ['AWB058', 'src/renderer/terms.ts', 'serializer.serialize({ scrollback: 0 })', "''"],
  ['AWB059', 'src/main/legacy-agent-session.ts', 'size === 1', 'size > 0'],
  ['AWB060', 'src/renderer/ProjectSidebar.tsx', 'projects.filter((project) => !project.temporary)', 'projects'],
  ['AWB061', 'src/main/store.ts', "language: settings.language === 'en' ? 'en' : 'zh-CN'", "language: 'zh-CN'"],
  ['AWB061', 'src/shared/i18n.ts', 'String(values[Number(index)])', 't(String(values[Number(index)]))'],
  ['AWB062', 'src/main/app-paths.ts', "path.join(installationDirectory, 'data')", "path.join(app.getPath('appData'), 'data')"],
  ['AWB062', 'assets/installer.nsh', '${AndIf} $R1 != "data"', '${AndIf} $R1 != "other"'],
  ['AWB063', 'src/main/app-updates.ts', 'driver.autoInstallOnAppQuit = false', 'driver.autoInstallOnAppQuit = true'],
  ['AWB064', 'src/main/store.ts', 'autoCheckUpdates: asBool(settings.autoCheckUpdates, true)', 'autoCheckUpdates: false'],
  ['AWB064', 'src/main/index.ts', 'automaticUpdates.setEnabled(next.settings.autoCheckUpdates)', 'automaticUpdates.setEnabled(true)'],
  ['AWB064', 'src/renderer/App.tsx', '<div id="toasts"', '<AppUpdate /><div id="toasts"'],
  ['AWB064', 'src/renderer/ProjectSidebar.tsx', '<Icon name="plus"', '<Icon name="more"'],
  ['AWB064', 'src/renderer/ProjectSidebar.tsx', "contextMenu('agents-filter')", "contextMenu('unused')"],
  ['AWB064', 'src/renderer/ProjectSidebar.tsx', "event.shiftKey && event.key === 'F10'", 'false'],
  ['AWB064', 'src/shared/locales/en.ts', '"临时会话": "TempSessions"', '"临时会话": "Temporary sessions"'],
  ['AWB065', 'src/renderer/ProjectSidebar.tsx', 'props.onNewProject()', 'void 0'],
  ['AWB065', 'src/renderer/styles/workbench.css', '.proj:has(:focus-visible) .project-add', '.proj .missing'],
  ['AWB065', 'src/renderer/Workspace.tsx', '<main className="center" id="center">', '<main className="center" id="center"><button data-a="newproj" />'],
  ['AWB066', 'src/main/store.ts', "theme: 'light'", "theme: 'dark'"],
  ['AWB066', 'src/renderer/index.html', 'data-theme="light"', 'data-theme="dark"'],
  ['AWB066', 'src/renderer/styles/workbench.css', 'font:calc(var(--fs,13px) * var(--content-zoom,1))/1.7 var(--mono)', 'font:12px/1.7 var(--mono)'],
  ['AWB066', 'src/renderer/icons.tsx', "fill={name === 'more' ? 'currentColor' : undefined}", 'fill="none"'],
  ['AWB067', 'src/renderer/ProjectSidebar.tsx', 't("最近")', '"Agents"'],
  ['AWB067', 'src/renderer/ProjectSidebar.tsx', "collapsed[project.id] ? 'folder' : 'folder-open'", "'folder'"],
  ['AWB067', 'src/renderer/styles/extra.css', '.sidebar-section-heading > [aria-expanded=true] .sidebar-disclosure { opacity:0; }', '.sidebar-section-heading .sidebar-disclosure { opacity:1; }'],
  ['AWB067', 'src/renderer/styles/extra.css', '.sidebar-disclosure { flex:none; pointer-events:none; }', '.sidebar-disclosure { margin-left:auto; pointer-events:none; }'],
  ['AWB068', 'src/renderer/MediaPreview.tsx', 'task?.destroy()', 'void 0'],
  ['AWB068', 'src/renderer/FilePane.tsx', '<MediaPreview', '<MissingPreview'],
  ['AWB068', 'electron.vite.config.ts', 'bundled-pdf-assets', 'missing-assets'],
  ['AWB069', 'src/renderer/DirectoryBrowser.tsx', '<ResourceDialog', '<div'],
  ['AWB069', 'src/renderer/Dialogs.tsx', "if (document.querySelector('dialog[open]')) return", 'void 0'],
  ['AWB070', 'src/renderer/usePreviewWheel.ts', 'passive: false', 'passive: true'],
  ['AWB070', 'src/renderer/MediaPreview.tsx', 'target.scrollTop + target.clientHeight', '0'],
  ['AWB070', 'src/renderer/FilePane.tsx', 'useContentZoom()', 'useState(1)'],
  ['AWB070', 'src/renderer/DiffPane.tsx', 'useContentZoom()', 'useState(1)'],
  ['AWB071', 'src/renderer/DocumentSearch.tsx', 'event.isComposing', 'false'],
  ['AWB071', 'src/renderer/MarkdownEditor.tsx', 'tr.insertText(value, position(match.from)', 'tr.delete(position(match.from)'],
  ['AWB071', 'src/renderer/SettingsView.tsx', "'Ctrl F'", "'Ctrl G'"],
  ['AWB071', 'src/renderer/styles/extra.css', '.document-search { position: absolute;', '.document-search { position: relative;'],
  ['AWB071', 'src/renderer/styles/extra.css', '.editor-surface { position: relative;', '.editor-surface { position: static;'],
  ['AWB072', 'src/renderer/MarkdownEditor.tsx', 'revealSearchRect(scroller', 'skipSearchReveal(scroller'],
  ['AWB073', 'src/renderer/styles/extra.css', 'container: editor / inline-size', 'container: none'],
  ['AWB073', 'src/renderer/styles/extra.css', 'width: clamp(272px,60cqi,420px)', 'width: 420px'],
  ['AWB073', 'src/renderer/styles/extra.css', '.media-zoom { min-width: 0; flex-wrap: wrap; }', '.media-zoom { min-width: 0; flex-wrap: nowrap; }'],
  ['AWB073', 'AGENTS.md', '日常自适应检查', '界面检查'],
  ['AWB074', 'src/main/content-search.ts', 'this.controller.abort()', 'void 0'],
  ['AWB074', 'src/main/content-search.ts', 'treePath(target, rel)', 'unsafePath(target, rel)'],
  ['AWB074', 'src/renderer/RightPanel.tsx', 'file-name-search', 'missing-name-search'],
  ['AWB074', 'src/renderer/RightPanel.tsx', 'project-search-options', 'missing-search-options'],
  ['AWB074', 'src/renderer/ContentSearchResults.tsx', 'contentSearchCancel(id)', 'noSearchCancel(id)'],
  ['AWB075', 'src/main/search-matcher.ts', 'new Worker(', 'unsafeWorker('],
  ['AWB075', 'src/renderer/SettingsView.tsx', "'Ctrl Shift F'", "'F12'"],
  ['AWB076', 'src/renderer/ContentSearchResults.tsx', '<summary title={file.path}>', '<summary title={file.path}><span className="content-search-count">1</span>'],
  ['AWB076', 'src/renderer/styles/extra.css', '.file-name-search .tx { width: 100%; height: 24px;', '.file-name-search .tx { width: 100%; height: 36px;'],
  ['AWB076', 'src/renderer/styles/extra.css', '.content-search-hit mark {', '.content-search-hit mark { font-weight: 600;'],
  ['AWB077', 'src/renderer/Workspace.tsx', 'documents[key]', 'documents.active'],
  ['AWB077', 'src/renderer/Workspace.tsx', 'onBaseline(tab.id, text)', 'onBaseline(shown.id, text)'],
  ['AWB077', 'src/renderer/DocumentSearch.tsx', "closest('.pane:not(.focus)')", "closest('.missing')"],
  ['AWB077', 'src-tauri/core/src/menu.rs', 'template.extend(layout_menu_items(language, &options["layout"]))', 'template.push(json!({ "id": "split-right", "label": "向右分栏", "enabled": true }))'],
  ['AWB077', 'src-tauri/core/src/menu.rs', 'items.extend(layout_menu_items(language, options))', 'items.push(json!({ "id": "merge", "label": "撤销分栏（合并）", "enabled": true }))'],
  ['AWB077', 'src/renderer/styles/workbench.css', '.panes{flex:1;display:grid;', '.panes{flex:1;display:flex;'],
  ['AWB077', 'src/renderer/Workspace.tsx', 'tabs={group.tabs.map((id) => tabById.get(id)!)}', 'tabs={mine}'],
  ['AWB077', 'src/renderer/Workspace.tsx', 'aria-busy={splitting || undefined}>', 'aria-busy={splitting || undefined}><div className="pane-caption">File</div>'],
  ['AWB078', 'src-tauri/core/src/menu.rs', 'role("pasteAndMatchStyle", "粘贴为纯文本", editable)', 'enabled("pasteAndMatchStyle", "粘贴为纯文本", editable)'],
  ['AWB078', 'src-tauri/core/src/menu.rs', 'role("copy", "复制"),', '{ "id": "copy", "label": said("复制") },'],
  ['AWB078', 'src-tauri/core/src/workbench.rs', '"menu:preview" => Ok(menu::preview_menu(&language))', '"menu:preview" => Ok(menu::file_menu(&language, &Value::Null))'],
  ['AWB078', 'src-tauri/src/lib.rs', 'if edit::is_role(&edit) { edit::run(window, &edit); return Value::Null }', ''],
  ['AWB078', 'src-tauri/src/edit.rs', String.raw`"pasteAndMatchStyle" => Some((b'V', true))`, '"pasteAndMatchStyle" => None'],
  ['AWB078', 'src-tauri/src/edit.rs', 'Input.dispatchKeyEvent', 'Input.insertText'],
  ['AWB079', 'src-tauri/core/src/workbench.rs', 'const TEST_WATCH: Duration = Duration::from_millis(8000);', 'const TEST_WATCH: Duration = Duration::from_millis(2500);'],
  ['AWB079', 'src-tauri/core/src/workbench.rs', 'translate(language, "请先填写命令。", &[] as &[String])', '"请先填写命令。".to_string()'],
  // The launch test ended by the leaving of the process alone, with no mark
  // of the command's own; the mark not taken out of what the page is shown.
  ['AWB079', 'src-tauri/core/src/workbench.rs', '"cmd" => format!("{command} & echo {id}:!ERRORLEVEL!"),', ''],
  ['AWB079', 'src-tauri/core/src/workbench.rs', 'kept.replace_range(at..at + len, "");', ''],
  ['AWB079', 'src-tauri/core/src/workbench.rs', 'const TEST_SETTLE: Duration = Duration::from_millis(180);', 'const TEST_SETTLE: Duration = Duration::from_millis(0);'],
  ['AWB079', 'src-tauri/core/src/workbench.rs', 'if running { result["running"] = json!(true); }', ''],
  ['AWB079', 'src-tauri/core/src/workbench.rs', '"pty:write" if self.closing.load(Ordering::SeqCst) => Ok(Value::Null),', ''],
  ['AWB079', 'src-tauri/core/src/workbench.rs', 'if self.closing.load(Ordering::SeqCst) { return Ok(json!("signal")) }', ''],
  ['AWB079', 'src-tauri/core/src/workbench.rs', 'pty::delete_history(&self.paths.data, &id);', ''],
  ['AWB079', 'src-tauri/core/src/pty.rs', 'for (key, value) in extra { builder.env(key, value); }', ''],
  ['AWB079', 'src-tauri/core/src/pty.rs', 'if !chunk.is_empty() && recorded_for_restore && !closing { let _ = append_ansi(&data, id, chunk); }', 'if !chunk.is_empty() { let _ = append_ansi(&data, id, chunk); }'],
  ['AWB079', 'package.json', 'node scripts/executor-test-check.mjs && ', ''],
  ['AWB079', 'src-tauri/core/src/i18n.rs', '("请先填写命令。", "Enter a command first."),', ''],
  ['AWB080', 'src-tauri/core/src/workbench.rs', 'shell::set_clipboard_text(if action == "copy-full" { &place.root } else { &relative });', 'return Ok(json!(place.root));'],
  ['AWB080', 'src-tauri/core/src/workbench.rs', 'if place.local && files::is_directory(Path::new(&place.root)) != Some(directory) {', ''],
  ['AWB080', 'src-tauri/core/src/workbench.rs', 'if files::is_directory(&full) != Some(directory) {', ''],
  ['AWB080', 'src-tauri/core/src/workbench.rs', 'shell::copy_to_new_file(', 'std::fs::copy('],
  ['AWB080', 'src-tauri/core/src/workbench.rs', 'translate(language, "源文件已更改"', '"源文件已更改".to_string()'],
  ['AWB080', 'src-tauri/core/src/shell.rs', 'ShellExecuteW(', 'std::process::Command::new("rust-open").arg('],
  ['AWB080', 'src-tauri/core/src/shell.rs', '.args(["/select,", &target])', '.args([&target])'],
  ['AWB080', 'src-tauri/core/src/shell.rs', 'SetClipboardData(CF_UNICODETEXT as u32, memory)', 'std::fs::write("clipboard.txt", text)'],
  ['AWB080', 'src-tauri/core/src/shell.rs', 'match crate::sys::rename_noreplace(&temporary, destination) {', 'std::fs::rename(&temporary, destination);'],
  ['AWB081', 'src-tauri/core/src/workbench.rs', 'if host.as_ref().is_some_and(|host| host["on"] == false) {', ''],
  ['AWB081', 'src-tauri/core/src/workbench.rs', '.ok_or_else(|| translate(language, "机器已移除", &[] as &[String]))', '.ok_or_else(|| "主机不存在".to_string())'],
  ['AWB081', 'src-tauri/core/src/workbench.rs', 'if host.as_ref().is_some_and(|host| host["on"] == false) {', 'if host.as_ref().is_none_or(|host| host["on"] == false) {'],
  ['AWB081', 'src-tauri/core/src/workbench.rs', 'let (project, host) = self.project_target(project_id, language)?;\n        let path = project["path"].as_str().unwrap_or("").to_string();\n        Ok(host.map(|host| (host, path)))', 'let (project, host) = (self.project(project_id, language)?, self.optional_host(self.project(project_id, language)?["host"].as_str().unwrap_or("local"), language)?);\n        let path = project["path"].as_str().unwrap_or("").to_string();\n        Ok(host.map(|host| (host, path)))'],
  ['AWB081', 'src-tauri/core/src/workbench.rs', 'let host = if project_id.is_empty() { None } else { self.project_target(&project_id, language)?.1 };', 'let host = if project_id.is_empty() { None } else { self.optional_host(self.project(&project_id, language)?["host"].as_str().unwrap_or("local"), language)? };'],
  ['AWB081', 'src-tauri/core/src/workbench.rs', 'let (project, host) = self.project_target(project_id, language)?;\n        let root = project["path"].as_str().unwrap_or("").to_string();', 'let (project, host) = (self.project(&project_id, language)?, self.optional_host(self.project(&project_id, language)?["host"].as_str().unwrap_or("local"), language)?);\n        let root = project["path"].as_str().unwrap_or("").to_string();'],
  ['AWB081', 'src-tauri/core/src/i18n.rs', '("机器已移除", "Machine has been removed"),', ''],
  ['AWB082', 'src-tauri/core/src/workbench.rs', '.find(|host| host["id"] == host_id).or_else(|| hosts.first())?;', '.find(|host| host["id"] == host_id)?;'],
  ['AWB082', 'src-tauri/core/src/workbench.rs', 'if platform == "windows" { return bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b\':\' && bytes[2] == b\'\\\\\' }', ''],
  ['AWB082', 'src-tauri/core/src/workbench.rs', 'Err(detail) => return Ok(json!({ "kind": "error", "detail": detail })),', 'Err(_) => false,'],
  ['AWB082', 'src-tauri/core/src/workbench.rs', 'let Some(host) = self.path_host(host_id) else { return Ok(files::check_path(input, language)) };', 'let Some(host) = self.project_target(host_id, language)?.1 else { return Ok(files::check_path(input, language)) };'],
  ['AWB082', 'src-tauri/core/src/workbench.rs', 'let Some(host) = self.path_host(host_id) else { return Ok(files::list_dir(input)) };', 'let Some(host) = self.optional_host(host_id, language)? else { return Ok(files::list_dir(input)) };'],
  ['AWB083', 'src-tauri/core/src/files.rs', 'pub const DOCUMENT_LIMIT: u64 = 10_000_000;', 'pub const DOCUMENT_LIMIT: u64 = 2_000_000;'],
  ['AWB083', 'src-tauri/core/src/files.rs', 'pub const MEDIA_LIMIT: u64 = 12_000_000;', 'pub const MEDIA_LIMIT: u64 = 10_000_000;'],
  ['AWB083', 'src-tauri/core/src/files.rs', 'Ok(read_local_stamped(root, rel, None, language)?.unwrap_or(missing_file()))', 'Ok(missing_file())'],
  ['AWB083', 'src-tauri/core/src/files.rs', '"version": Value::Null, "tooBig": true', '"version": "stale", "tooBig": true'],
  ['AWB083', 'src-tauri/core/src/files.rs', 'if bytes.len() as u64 > DOCUMENT_LIMIT {', ''],
  ['AWB083', 'src-tauri/core/src/git.rs', 'if bytes.len() as u64 > files::DOCUMENT_LIMIT {', 'if bytes.len() as u64 > 2_000_000 {'],
  ['AWB083', 'src-tauri/core/src/preview.rs', 'const DRAFT_LIMIT: usize = crate::files::DOCUMENT_LIMIT as usize;', 'const DRAFT_LIMIT: usize = 2 * 1024 * 1024;'],
  ['AWB084', 'src-tauri/core/src/git.rs', 'translate(language, "{{0}}：{{1}}", &[rel, reason])', 'format!("{rel}：无法读取")'],
  ['AWB084', 'src-tauri/core/src/git.rs', 'unwrap_or_else(|| translate(language, "无法读取", &[] as &[String]))', 'unwrap_or_else(|| "无法读取".to_string())'],
  ['AWB084', 'src-tauri/core/src/git.rs', 'files::errno_name(&error)', 'None'],
  ['AWB084', 'src-tauri/core/src/git.rs', 'translate(language, "{{0}}：无法读取 Git 状态", &[prefix.clone()])', 'format!("{prefix}：无法读取 Git 状态")'],
  ['AWB084', 'src-tauri/core/src/files.rs', 'ERROR_ACCESS_DENIED | ERROR_PRIVILEGE_NOT_HELD => "EPERM"', 'ERROR_ACCESS_DENIED | ERROR_PRIVILEGE_NOT_HELD => "EACCES"'],
  ['AWB084', 'src-tauri/core/src/resources.rs', 'let unmovable = || t(language, "无法移入回收站");', 'let unmovable = || "无法移入回收站".to_string();'],
  ['AWB084', 'src-tauri/core/src/resources.rs', 'Err(_) => t(language, "无效 URL"),', 'Err(_) => "无效 URL".to_string(),'],
  ['AWB084', 'src-tauri/core/src/shells.rs', 'translate(language, "Git Bash 或本机 Bash", &[] as &[String])', '"Git Bash 或本机 Bash".to_string()'],
  ['AWB084', 'src-tauri/core/src/i18n.rs', '("{{0}}：{{1}}", "{{0}}: {{1}}"),', ''],
  ['AWB084', 'src-tauri/core/src/i18n.rs', '("无法读取", "Cannot read"),', ''],
  ['AWB084', 'src-tauri/core/src/i18n.rs', '("无法移入回收站", "Cannot move to the Recycle Bin"),', ''],
  ['AWB084', 'src-tauri/core/src/i18n.rs', '("粘贴为纯文本", "Paste as plain text"),', ''],
  ['AWB084', 'src-tauri/core/src/i18n.rs', '("重新读取", "Reload"),', ''],
  // A message taken out of the code altogether is not seen by the check of
  // callers, which goes from the code to the catalog; this rule holds it.
  ['AWB084', 'src-tauri/core/src/git.rs', 'translate(language, "{{0}}：无法读取 Git 状态", &[prefix.clone()])', '"x".to_string()'],
  // A URL judged by its text, by another parser, or with the parser's own
  // message put into words of the kernel's own; a command trimmed to a
  // different set of characters, or the byte order mark taken off it; a
  // false value where servers are looked for asked to be an object.
  ['AWB085', 'src-tauri/core/src/resources.rs', 'ada_url::Url::parse(url, None)', 'url::Url::parse(url, None)'],
  ['AWB085', 'src-tauri/core/src/resources.rs', 'let mut parsed = ada_url::Url::parse(&url, None)', 'let mut parsed = ada_url::Url::parse(&url, Some(&base))'],
  ['AWB085', 'src-tauri/core/src/resources.rs', 'let parsed = ada_url::Url::parse(text, None).map_err(|_| "Invalid URL".to_string())?;', 'let parsed = ada_url::Url::parse(text, None).map_err(|_| t(language, "Invalid URL"))?;'],
  ['AWB085', 'src-tauri/core/src/resources.rs', 'Err(_) => return Err("Invalid URL".to_string()),', 'Err(_) => return Err(t(language, "Invalid URL")),'],
  ['AWB085', 'src-tauri/core/src/resources.rs', "fn js_trim(text: &str) -> &str { text.trim_matches(is_js_whitespace) }", 'fn js_trim(text: &str) -> &str { text.trim() }'],
  ['AWB085', 'src-tauri/core/src/resources.rs', " | '\\u{feff}')", "')"],
  ['AWB085', 'src-tauri/core/src/resources.rs', " | '\\u{feff}')", " | '\\u{feff}' | '\\u{85}')"],
  ['AWB085', 'src-tauri/core/src/resources.rs', "js_trim(text).is_empty() || text.contains('\\0')", "text.trim().is_empty() || text.contains('\\0')"],
  ['AWB085', 'src-tauri/core/src/resources.rs', "if is_truthy(value) { object_or(value, language) } else { Ok(EMPTY_MAP.get_or_init(Map::new)) }", 'object_or(value, language)'],
  ['AWB085', 'src-tauri/core/src/resources.rs', 'let servers = asked(value, language)?;', 'let servers = object_or(value, language)?;'],
  // A configuration read strictly, with its mark kept; a TOML document
  // refused in words; a file written only if it is the same file.
  ['AWB086', 'src-tauri/core/src/resources.rs', 'let data = fs::read(path).map_err(|error| error.to_string())?;', 'let data = fs::read_to_string(path).map_err(|error| error.to_string())?;'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'Ok(text) => Ok(text),', 'Ok(text) => Ok(text.trim_start_matches(\'\\u{feff}\').to_string()),'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'Err(_) => Err("The encoded data was not valid for encoding utf-8".to_string()),', 'Err(error) => Err(error.to_string()),'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'Err(_) => Err("The encoded data was not valid for encoding utf-8".to_string()),', 'Err(_) => Err(t(language, "The encoded data was not valid for encoding utf-8")),'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'if !same || read_text(path, language)? != before {', 'if read_text(path, language)? != before {'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'current.regular && current.number == previous.number', 'current.regular'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'fs::rename(&backup_stage, &backup).map_err(|error| error.to_string())?;', 'fs::copy(path, &backup).map_err(|error| error.to_string())?;'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'fs::hard_link(&temp, path).map_err(|error| error.to_string())?;', 'fs::rename(&temp, path).map_err(|error| error.to_string())?;'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'for staged in [&temp, &backup_stage] {', 'for staged in [&temp] {'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'let (order, source) = json_edit_source(&before);', 'let source = before.clone();'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'let next = with_mark(order, &next);', 'let next = next;'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'let moved = with_mark(order, &moved);', 'let moved = moved;'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'if description.is_empty() || description.chars().count() > 8192 {', 'if description.is_empty() || description.chars().count() > 1024 {'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'let (order, rest) = json_edit_source(&before);', 'let (order, rest) = json_edit_source(before);'],
  // Said to be skipped for a duplicate alone: marked so for any failure,
  // the user is told a server that failed to be written was only skipped.
  ['AWB086', 'src-tauri/core/src/resources.rs', 'json!({ "ok": false, "error": error.message, "skipped": error.duplicate })', 'json!({ "ok": false, "error": error.message, "skipped": true })'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'result["skipped"] = json!(outcome["skipped"].as_bool().unwrap_or(false));', 'result["skipped"] = json!(true);'],
  // The files of the machine that has them stand between a resource
  // operation and the configuration. The local ones must lead to the two
  // functions above, or the strict decoding, the BOM and the check of the
  // file's identity are stepped around.
  ['AWB086', 'src-tauri/core/src/resources.rs', '        read_text(Path::new(file), &self.language)', '        fs::read_to_string(file).map_err(|error| error.to_string())'],
  ['AWB086', 'src-tauri/core/src/resources.rs', '        atomic_text(Path::new(file), before, next, &self.language)', '        fs::write(file, next).map_err(|error| error.to_string())'],
  ['AWB086', 'src-tauri/core/src/resources.rs', '        rename_skill(Path::new(root), Path::new(source), Path::new(dest), &self.language)', '        fs::rename(source, dest).map_err(|error| error.to_string())'],
  // A Skill named as the list showed it, read through the files, not from
  // the path given by the one who asked.
  ['AWB086', 'src-tauri/core/src/resources.rs', 'fn skill_info(files: &dyn ResourceFiles, file: &str, language: &str) -> Result<SkillInfo, String> {', 'fn skill_info(files: &dyn ResourceFiles, file: &Path, language: &str) -> Result<SkillInfo, String> {'],
  // A scope read wrong; a machine not asked before the executor; a template
  // that does not come before the executor's own paths; a key said of a
  // target as an empty string.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'Some(id) => ("local".into(), id.to_string()),', 'Some(id) => (id.to_string(), String::new()),'],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'None => (field(scope, "hostId"), field(scope, "executorId")),', 'None => ("local".into(), field(scope, "executorId")),'],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'crate::templates::machine(db, &host_id, true, language)?;', ''],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'Some(template) => (template_target(template), false),', 'Some(template) => match defaults.iter().find(|item| item.id == id) { Some(found) => (found.clone(), false), None => (template_target(template), false) },'],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'if !target.bare { value["skillAdapter"] = json!(target.skill_adapter); }', 'value["skillAdapter"] = json!(target.skill_adapter);'],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'if !target.template_name.is_empty() { value["templateName"] = json!(target.template_name); }', 'value["templateName"] = json!(target.template_name);'],
  // A mark that does not see the template lent or the way the machine is
  // signed in to; a check that lets a change through.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'let material = json!([host["id"], host["addr"], host["user"], host["port"], host["platform"], host["auth"], template]).to_string();', 'let material = json!([host["id"], host["addr"], host["user"], host["port"], host["platform"]]).to_string();'],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'if fingerprint(db, scope, language)?.0 != self.0 { return Err(t(language, "资源目标已改变，请刷新后重试")) }', 'Ok(())'],
  // A scope chosen twice said twice; a file shared by two executors written
  // twice; a path told apart by case on Windows; a scope that cannot be used
  // failing the whole call.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'if !unique.contains(&pair) { unique.push(pair); }', 'unique.push(pair);'],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'let identity = if windows { canonical.to_lowercase() } else { canonical.clone() };', 'let identity = canonical.clone();'],
  // Two files that differ only by case on a Windows host said to be one
  // file, by asking whether this machine is Windows.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'let windows = resolved.target.windows;', 'let windows = cfg!(windows);'],
  // A file on another machine named as this machine names it, and so two
  // executors on it lent the same file are not known to share it.
  ['AWB089', 'src-tauri/core/src/resources.rs', '&json!({ "op": "canonical", "path": &file })', '&json!({ "op": "canonical", "path": "" })'],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'let key = json!([host_id, identity, entry.get("id").filter(|item| item.is_string()).unwrap_or(&entry["name"])]).to_string();', 'let key = json!([host_id, identity, id]).to_string();'],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'if scopes.is_empty() { return Err(t(language, "请选择至少一个 Code Agent")) }', ''],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'result["skipped"] = json!(outcome["skipped"].as_bool().unwrap_or(false));', 'result["skipped"] = json!(true);'],
  ['AWB089', 'src-tauri/core/src/resources.rs', 'resources.busy.store(false, Ordering::SeqCst);', ''],
  // The files handed to an operation before the guard is asked again; a
  // change made in between is written as if it had not been.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'resolved.check(db, language).map_err(Refused::from).and_then(|()| run(&mut resolved, entry, &canonical));', 'run(&mut resolved, entry, &canonical);'],
  // An entry said to be done on another machine before what was changed
  // there is made to be so.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'let tried = tried.and_then(|()| resolved.publish(data, db, language).map_err(Refused::from));', 'let tried = tried;'],
  // The host asked what it has for every executor chosen, not once.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'if !template && !profiles.contains_key(&host_id) { profiles.insert(host_id.clone(), remote_targets(data, &host, language)?); }', 'if !template { profiles.insert(host_id.clone(), remote_targets(data, &host, language)?); }'],
  // What the operation is to change handed over before the host's answer is
  // looked at again.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'let snapshot = crate::remote_resources::remote_snapshot(data, &host, &files, &roots, &|| mark.check(db, scope, language), None, language)?;', 'let snapshot = crate::remote_resources::remote_snapshot(data, &host, &files, &roots, &|| Ok(()), None, language)?;'],
  // A change kept for a remote host and never asked of it.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'snapshot.publish(data, &self.host, &|| self.check(db, language), language)', 'Ok(())'],
  // A Skill folder opened on another machine.
  ['AWB089', 'src-tauri/core/src/resources.rs', 'if scope_of(scope).0 != "local" { return Err(t(language, "此操作仅适用于本机 Skill")) }', ''],
  // The arguments of the Skill channels moved over by one; a target read for
  // a machine other than the one asked of.
  ['AWB089', 'src-tauri/core/src/workbench.rs', '"resources:skill-open" => resources::open_skill(&self.paths.data, &self.db.lock().expect("db").clone(), args.first().unwrap_or(&Value::Null), args.get(1).unwrap_or(&Value::Null), &language)', '"resources:skill-open" => resources::open_skill(&self.db.lock().expect("db").clone(), args.get(1).unwrap_or(&Value::Null), args.get(2).unwrap_or(&Value::Null), &language)'],
  ['AWB089', 'src-tauri/core/src/workbench.rs', 'str_arg(args, 0), args.get(1).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), args.get(2).and_then(|value| value.as_array()).map(|list| list.iter().filter_map(|item| item.as_str().map(|item| item.to_string())).collect::<Vec<_>>()).as_ref(), &language),', 'str_arg(args, 0), args.get(2).and_then(|value| value.as_array()).map(|list| list.as_slice()).unwrap_or(&[]), args.get(3).and_then(|value| value.as_array()).map(|list| list.iter().filter_map(|item| item.as_str().map(|item| item.to_string())).collect::<Vec<_>>()).as_ref(), &language),'],
  ['AWB089', 'src-tauri/core/src/workbench.rs', '"resources:targets" => resources::targets(&self.paths.data, &self.db.lock().expect("db").clone(), args.first().and_then(|value| value.as_str()).unwrap_or("local"), &language)', '"resources:targets" => resources::targets(&self.paths.data, &self.db.lock().expect("db").clone(), "local", &language)'],
  ['AWB089', 'src-tauri/core/src/workbench.rs', '            "resources:open-recommendation" => resources::open_recommendation(str_arg(args, 0), &language).map(|_| Value::Null),\n', ''],
  // The old channel back in the bridge.
  ['AWB089', 'src/renderer/tauri-awb.ts', "openSkillRecommendation: (id) => call('resources:open-recommendation', [id]),", "saveResourceTarget: (target) => call('resources:target', [target]),"],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'fs::hard_link(source, dest).map_err(|error| error.to_string())?;', 'fs::rename(source, dest).map_err(|error| error.to_string())?;'],
  ['AWB086', 'src-tauri/core/src/resources.rs', 'env("OPENCODE_CONFIG")', 'None'],
  // The environment of this machine read for a host, so that a test's
  // resource home is not the only home a test has.
  ['AWB086', 'src-tauri/core/src/resources.rs', 'if isolated { None } else', 'if false { None } else'],
  // A built-in agent named in a resource channel without the resource home
  // isolated reads and writes the user's own configuration files. The case
  // is told apart from the other one that guards the resource home by the
  // Skill folder it makes.
  ['AWB087', 'src-tauri/core/tests/behavior.rs', 'fs::create_dir_all(home.join(".claude").join("skills").join("one")).unwrap();\r\n    let _home = var_guard("HOME", home.to_str().unwrap());\r\n    let _resource = var_guard("AWB_RESOURCE_HOME", home.to_str().unwrap());', 'fs::create_dir_all(home.join(".claude").join("skills").join("one")).unwrap();\r\n    let _home = var_guard("HOME", home.to_str().unwrap());\r\n    let _elsewhere = var_guard("AWB_ELSEWHERE", home.to_str().unwrap());'],
  // A resource path taken as absolute without the control-character check
  // lets a path with a newline or a byte order mark into a configuration
  // file. Each mutation below breaks one clause of one rule and no other.
  ['AWB088', 'src-tauri/core/src/templates.rs', 'if has_control(input) || !absolute || forbidden {', 'if !absolute || forbidden {'],
  ['AWB088', 'src-tauri/core/src/templates.rs', "after_drive.contains(['<', '>', '\"', '|', '?', '*'])", "after_drive.contains(['<', '>', '|', '?', '*'])"],
  // Secrets replaced shortest first leave a longer secret's remains showing
  // where the shorter one lies inside it.
  ['AWB088', 'src-tauri/core/src/templates.rs', 'secrets.sort_by_key(|value| std::cmp::Reverse(value.chars().count()));', ''],
  ['AWB088', 'src-tauri/core/src/templates.rs', 'filter(|row| row["secret"] == true)', 'filter(|row| row["secret"] == true || row["k"].starts_with("PELLO_"))'],
  ['AWB088', 'src-tauri/core/src/templates.rs', '"claude" | "pi" | "omp" => format == "standard" && adapter == executor_id,', '"claude" | "pi" | "omp" => format == "standard",'],
  ['AWB088', 'src-tauri/core/src/templates.rs', 'check_compatibility(&template, executor_id, language)?;', ''],
  // A template lent across machines, or before the binding is replaced.
  ['AWB088', 'src-tauri/core/src/templates.rs', 'if text(&template, "hostId") != host_id { return Err(t(language, "模板必须属于所选机器")); }', ''],
  ['AWB088', 'src-tauri/core/src/templates.rs', 'if !first_time { return false; }', ''],
  ['AWB088', 'src-tauri/core/src/templates.rs', 'object.remove("resources");', ''],
  // A save that changes memory before the disk leaves the two apart when the
  // write fails; a terminal made again without its environment loses the
  // template's; a test that shows secrets or the dialog's environment.
  ['AWB088', 'src-tauri/core/src/workbench.rs', '"templates:save", "templates:bind", "templates:delete"]', '"templates:save", "templates:delete"]'],
  ['AWB088', 'src-tauri/core/src/workbench.rs', 'store::save_database(&self.database_path(), &next)?;\n        *self.db.lock().expect("db") = next.clone();', '*self.db.lock().expect("db") = next.clone();\n        store::save_database(&self.database_path(), &next)?;'],
  ['AWB088', 'src-tauri/core/src/workbench.rs', 'self.emit.clone(), &env).map(|_| Value::Null)', 'self.emit.clone(), &[]).map(|_| Value::Null)'],
  ['AWB088', 'src-tauri/core/src/workbench.rs', 'let text = templates::redact_output(&collected.lock().expect("test output"), &rows);', 'let text = collected.lock().expect("test output").clone();'],
  // A browse of this machine, asked of the host; one that lists files
  // without being asked, or that forgets which language to speak; a path
  // asked of the host as it was typed, or a relative one.
  ['AWB090', 'src-tauri/core/src/workbench.rs', 'str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), &language),', 'str_arg(args, 1), bool_arg(args, 2).unwrap_or(true), &language),'],
  ['AWB090', 'src-tauri/core/src/workbench.rs', 'str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), &language),', 'str_arg(args, 1), bool_arg(args, 2).unwrap_or(false), "en"),'],
  ['AWB090', 'src-tauri/core/src/resources.rs', 'if host_id == "local" { return Err(t(language, "请选择 SSH 机器")) }', ''],
  ['AWB090', 'src-tauri/core/src/resources.rs', 'let path = if input.is_empty() { String::new() } else { crate::templates::resource_path(input, windows, language)? };', 'let path = input.to_string();'],
  ['AWB090', 'src-tauri/core/src/resources.rs', 'let host = crate::templates::machine(db, host_id, true, language)?.clone();', 'let host = db["hosts"].as_array().expect("hosts").iter().find(|host| host["id"] == host_id).cloned().expect("host");'],
  ['AWB090', 'src-tauri/core/src/remote_resources.rs', 'if files { result["files"] = json!(entries(listed.files)); }', 'result["files"] = json!(entries(listed.files));'],
  // An About page told one address and a link opening another; an author
  // named in one language whatever the interface speaks; a bridge without
  // the two members the page and the resource dialogs call.
  ['AWB091', 'src-tauri/core/src/workbench.rs', '"app:homepage" => { shell::open_external(HOMEPAGE); Ok(Value::Null) }', '"app:homepage" => { shell::open_external("https://github.com/FangYang970206/Pello"); Ok(Value::Null) }'],
  ['AWB091', 'src-tauri/core/src/workbench.rs', '"author": if language == "en" { "FangYang" } else { "方阳" }', '"author": "方阳"'],
  ['AWB091', 'src-tauri/core/src/workbench.rs', '"version": env!("CARGO_PKG_VERSION")', '"version": "0.1.18"'],
  ['AWB091', 'src/renderer/tauri-awb.ts', "browseResources: (hostId, input, files) => call('resources:browse', [hostId, input, files])", "browseResources: (hostId, input, files) => call('path:list', [hostId, input])"],
  ['AWB091', 'src/renderer/tauri-awb.ts', "openHomepage: () => call('app:homepage')", ''],
  // A file sent again though it is the same; one read before it is known
  // to be over the limit; one found changed while read and shown anyway; a
  // host that cannot be asked taken for a file gone; a refresh without
  // the stamp it was asked with.
  ['AWB092', 'src-tauri/core/src/files.rs', 'if Some(stamp.as_str()) == known { return Ok(None) }', ''],
  ['AWB092', 'src-tauri/core/src/files.rs', 'if before.size > limit_for(&relative) {', 'if false {'],
  ['AWB092', 'src-tauri/core/src/files.rs', 'Some((_, Some(after))) if after == before =>', 'Some(_) =>'],
  ['AWB092', 'src-tauri/core/src/git.rs', '"PELLO-MISSING" => Ok(Some(files::missing_file())),', '"PELLO-MISSING" => Err(String::from("missing")),'],
  ['AWB092', 'src-tauri/core/src/git.rs', 'if Some(stamp) == known { return Ok(None) }', ''],
  ['AWB092', 'src-tauri/core/src/workbench.rs', 'args.get(2).and_then(|value| value.as_str()), &language)?.unwrap_or(Value::Null)),', 'None, &language)?.unwrap_or(Value::Null)),'],
  ['AWB088', 'src-tauri/core/src/workbench.rs', '.map(|template| template["env"].as_array().cloned().unwrap_or_default()).unwrap_or_else(|| request["env"].as_array().cloned().unwrap_or_default())', '.map(|template| [template["env"].as_array().cloned().unwrap_or_default(), request["env"].as_array().cloned().unwrap_or_default()].concat()).unwrap_or_default()'],
  ['AWB088', 'src-tauri/core/src/workbench.rs', 'templates::prune(&mut next);\n        for binding in bindings.as_array().cloned().unwrap_or_default() {', 'for binding in bindings.as_array().cloned().unwrap_or_default() {'],
  // The About page shown with the page heading drawn a second time; its
  // homepage link navigating itself instead of the kernel opening it; a made
  // up version on it; its logo not blinking any more.
  ['AWB093', 'src/renderer/SettingsView.tsx', "if (section === 'about') body = <AboutView />", "if (section === 'none') body = <AboutView />"],
  ['AWB093', 'src/renderer/SettingsView.tsx', "{section !== 'about' ? <h1>{title}</h1> : null}", '<h1>{title}</h1>'],
  ['AWB093', 'src/renderer/SettingsView.tsx', '{LEADS[section] ? <p className="lead">{LEADS[section]}</p> : null}', '<p className="lead">{LEADS[section]}</p>'],
  ['AWB093', 'src/renderer/AboutView.tsx', 'event.preventDefault(); void window.awb.openHomepage()', 'void window.open(meta.homepage)'],
  ['AWB093', 'src/renderer/AboutView.tsx', "<dd data-about=\"version\">{meta ? `v${meta.version}` : '—'}</dd>", '<dd data-about="version">v1.0.0</dd>'],
  ['AWB093', 'src/renderer/styles/extra.css', 'animation: pello-blink 1.6s ease-in-out; }', '}'],
  ['AWB093', 'src/renderer/styles/extra.css', '@media (prefers-reduced-motion: reduce) { .about-eye { animation: none; } }', '.about-reduced { display: none; }'],
  ['AWB093', 'package.json', '"check:about": "node scripts/about-check.mjs",', ''],
]
cases.forEach(([id, file, before, after], index) => {
  const mutated = new Map(files)
  assert.ok(files.get(file)?.includes(before), `${id} (case ${index + 1}, ${file}): mutation is stale: ${JSON.stringify(before.slice(0, 80))}`)
  let text = files.get(file).replaceAll(before, after)
  if (id === 'AWB012') text = text.replaceAll('versionOf(fs.readFileSync(abs)) !== version', 'false')
  mutated.set(file, text)
  const errors = checkInvariants(mutated)
  assert.ok(errors.some((error) => error.id === id), `${id} (case ${index + 1}, ${file}): lint did not catch its regression: ${JSON.stringify(before.slice(0, 80))}`)
})
console.log(`Invariant lint negative cases passed (${cases.length})`)
