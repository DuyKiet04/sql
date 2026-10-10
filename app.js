import { PGlite } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite/dist/index.js";
import { postgis } from "https://cdn.jsdelivr.net/npm/@electric-sql/pglite-postgis/dist/index.js";

// ==========================================
// 1. DATABASE ADAPTERS & LOGICAL BACKUP
// ==========================================
class DatabaseAdapter {
    async init() {}
    async createDB(name) {}
    async execute(dbName, sql) { return []; }
    async getTables(dbName) { return []; }
    async getTableSchema(dbName, tableName) { return []; }
    async exportLogical(dbName) {
        let exportData = { engine: AppState.currentEngine, dbName: dbName, tables: [] };
        const tables = await this.getTables(dbName);
        for(let t of tables) {
            const rows = await this.execute(dbName, `SELECT * FROM ${t}`);
            exportData.tables.push({ tableName: t, data: rows }); // Logical data dump
        }
        return exportData;
    }
}

class PGAdapter extends DatabaseAdapter {
    constructor() { super(); this.instances = {}; }
    async createDB(name) {
        if (!this.instances[name]) {
            this.instances[name] = new PGlite(`idb://pg_${name}`, { extensions: { postgis } });
            await this.instances[name].exec(`CREATE EXTENSION IF NOT EXISTS postgis;`);
        }
    }
    async execute(dbName, sql) {
        const res = await this.instances[dbName].exec(sql);
        let lastRes = Array.isArray(res) ? res[res.length - 1] : res;
        return lastRes?.rows || [];
    }
    async getTables(dbName) {
        const rows = await this.execute(dbName, `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name NOT IN ('spatial_ref_sys', 'geometry_columns', 'geography_columns')
        `);
        return rows.map(r => r.table_name);
    }
    async getTableSchema(dbName, tableName) {
        return await this.execute(dbName, `
            SELECT column_name, data_type, is_nullable, column_default, 
            (SELECT COUNT(*) FROM information_schema.key_column_usage kcu WHERE kcu.table_name = c.table_name AND kcu.column_name = c.column_name) as is_pk
            FROM information_schema.columns c WHERE table_name = '${tableName}'
        `);
    }
}

class SQLiteAdapter extends DatabaseAdapter {
    constructor() { super(); this.instances = {}; this.SQL = null; }
    async init() { this.SQL = await initSqlJs({ locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}` }); }
    async createDB(name) { if (!this.instances[name]) this.instances[name] = new this.SQL.Database(); }
    async execute(dbName, sql) {
        const res = this.instances[dbName].exec(sql);
        if (!res || res.length === 0) return [];
        return res[0].values.map(row => {
            let obj = {}; res[0].columns.forEach((col, i) => obj[col] = row[i]); return obj;
        });
    }
    async getTables(dbName) {
        const rows = await this.execute(dbName, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        return rows.map(r => r.name);
    }
    async getTableSchema(dbName, tableName) {
        const rows = await this.execute(dbName, `PRAGMA table_info('${tableName}')`);
        return rows.map(r => ({ column_name: r.name, data_type: r.type, is_nullable: r.notnull ? 'NO' : 'YES', is_pk: r.pk > 0 ? 1 : 0 }));
    }
}

class MySQLAdapter extends DatabaseAdapter {
    async createDB(name) { alasql(`CREATE DATABASE IF NOT EXISTS ${name}`); }
    async execute(dbName, sql) {
        alasql(`USE ${dbName}`);
        let res = alasql(sql); return typeof res === 'number' ? [] : res;
    }
    async getTables(dbName) {
        alasql(`USE ${dbName}`); return Object.keys(alasql.databases[dbName].tables);
    }
    async getTableSchema(dbName, tableName) {
        alasql(`USE ${dbName}`);
        const cols = alasql.databases[dbName].tables[tableName].columns;
        return cols ? cols.map(c => ({ column_name: c.columnid, data_type: c.dbtypeid || 'UNKNOWN', is_nullable: 'YES', is_pk: 0 })) : [];
    }
}

// ==========================================
// 2. STATE MANAGER
// ==========================================
const AppState = {
    currentEngine: 'postgres',
    activeDBs: { postgres: 'public', sqlite: 'main', mysql: 'public' },
    dbLists: { postgres: ['public'], sqlite: ['main'], mysql: ['public'] },
    adapters: { postgres: new PGAdapter(), sqlite: new SQLiteAdapter(), mysql: new MySQLAdapter() },
    editors: {},
    schemaMetadata: {}, // For Autocomplete
    queryHistory: JSON.parse(localStorage.getItem('ide_history') || '[]'),
    
    // Grid Data State
    gridData: [],
    gridFiltered: [],
    currentPage: 1,
    pageSize: 50,
};

async function initSystem() {
    logMessage("Khởi tạo hệ thống...", "info");
    await AppState.adapters.sqlite.init();

    const savedTheme = localStorage.getItem('ide_theme') || 'dark';
    if(savedTheme === 'light') {
        document.body.setAttribute('data-theme', 'light');
        document.getElementById('btn-theme-toggle').innerHTML = '<i class="ri-moon-line"></i>';
    } else {
        document.getElementById('btn-theme-toggle').innerHTML = '<i class="ri-sun-line"></i>';
    }
    
    // Khôi phục danh sách DB
    const savedLists = localStorage.getItem('ide_db_lists');
    if(savedLists) AppState.dbLists = JSON.parse(savedLists);
    
    // --- ĐOẠN MỚI THÊM: Khôi phục DB đang Active ---
    const savedActive = localStorage.getItem('ide_active_dbs');
    if(savedActive) AppState.activeDBs = JSON.parse(savedActive);
    // ------------------------------------------------
    
    for (let engine of ['postgres', 'sqlite', 'mysql']) {
        for (let db of AppState.dbLists[engine]) {
            await AppState.adapters[engine].createDB(db);
        }
    }
    
    initEditors(); setupResizers(); bindEvents();
    await refreshExplorer();
    logMessage("Hệ thống sẵn sàng!", "success");
}
function initEditors() {
    const currentTheme = localStorage.getItem('ide_theme') || 'dark';
    const cmTheme = currentTheme === 'light' ? 'default' : 'dracula'; // Light dùng default, Dark dùng dracula

    const config = { 
        mode: "text/x-sql", 
        theme: cmTheme, 
        lineNumbers: true, 
        matchBrackets: true 
    };
    
    AppState.editors.a = CodeMirror.fromTextArea(document.getElementById("editor-a"), config);
    AppState.editors.b = CodeMirror.fromTextArea(document.getElementById("editor-b"), {
        ...config, 
        extraKeys: { 
            "Ctrl-Space": "autocomplete",
            "F5": () => runQuery('b'), 
            "Ctrl-Enter": () => runQuery('b') 
        }
    });

    // --- THÊM TÍNH NĂNG AUTOCOMPLETE NHƯ VS CODE ---
    // Hàm dùng chung để tự động gọi gợi ý khi gõ chữ hoặc dấu chấm
    const autoSuggest = (instance, changeObj) => {
        // Chỉ kích hoạt khi gõ chữ cái, số, dấu gạch dưới hoặc dấu chấm (cho alias)
        if (/^[a-zA-Z0-9_.]+$/.test(changeObj.text[0])) {
            if (!instance.state.completionActive) {
                CodeMirror.commands.autocomplete(instance, null, { completeSingle: false });
            }
        }
    };

    // Gắn sự kiện lắng nghe gõ phím cho cả 2 Editor
    AppState.editors.a.on("inputRead", autoSuggest);
    AppState.editors.b.on("inputRead", autoSuggest);
}

// --- BÊ TỪ CODE CŨ: Hàm phân tích gợi ý thông minh ---
function customSQLHint(editor, options) {
    const cur = editor.getCursor(); 
    const curLine = editor.getLine(cur.line);
    let start = cur.ch, end = start;
    
    while (end < curLine.length && /[\w\.]/.test(curLine.charAt(end))) ++end;
    while (start && /[\w\.]/.test(curLine.charAt(start - 1))) --start;
    
    const curWord = curLine.slice(start, end).toLowerCase();
    const tables = options.tables || {};
    
    // Xử lý khi gõ dấu chấm (vd: customers.id)
    if (curWord.includes('.')) {
        let parts = curWord.split('.');
        let tName = parts[0], searchCol = parts[1];
        let matchedTable = Object.keys(tables).find(t => t.toLowerCase() === tName);
        if (matchedTable) {
            let matches = tables[matchedTable].filter(col => col.toLowerCase().includes(searchCol));
            return { list: matches, from: CodeMirror.Pos(cur.line, start + tName.length + 1), to: CodeMirror.Pos(cur.line, end) };
        }
    }
    
    let suggestions = ["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "CREATE", "TABLE", "UPDATE", "SET", "DELETE", "ORDER BY", "GROUP BY", "AND", "OR", "LIMIT", "JOIN"];
    const fullText = editor.getValue().toLowerCase(); 
    let contextColumns = [], otherColumns = [];

    // Phân loại mức độ ưu tiên: Cột trong bảng đang viết > Từ khóa > Cột khác
    for (let tableName in tables) {
        if (!suggestions.includes(tableName)) suggestions.push(tableName);
        let isTableInUse = fullText.includes(tableName.toLowerCase());
        tables[tableName].forEach(col => {
            if (isTableInUse) { 
                if (!contextColumns.includes(col)) contextColumns.push(col); 
            } else { 
                if (!otherColumns.includes(col)) otherColumns.push(col); 
            }
        });
    }

    let matches = [...contextColumns, ...suggestions, ...otherColumns].filter(word => word.toLowerCase().includes(curWord));
    return { list: matches, from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, end) };
}

// --- CẬP NHẬT LẠI: Trỏ cấu hình hint về hàm custom vừa thêm ---
function updateAutocompleteHint() {
    const hintConfig = { hint: customSQLHint, tables: AppState.schemaMetadata };
    AppState.editors.a.setOption("hintOptions", hintConfig);
    AppState.editors.b.setOption("hintOptions", hintConfig);
}

// ==========================================
// 3. EXECUTION & SAFE GRID RENDER
// ==========================================
async function runQuery(editorId) {
    const editor = AppState.editors[editorId];
    let sql = editor.somethingSelected() ? editor.getSelection() : editor.getValue();
    if(!(sql = sql.trim())) return logMessage("Vui lòng nhập lệnh SQL", "error");

    const engine = AppState.currentEngine;
    const db = AppState.activeDBs[engine];
    
    try {
        const start = performance.now();
        const results = await AppState.adapters[engine].execute(db, sql);
        const time = (performance.now() - start).toFixed(2);
        
        logMessage(`Thực thi thành công (${time}ms). ${results.length} rows.`, "success");
        saveHistory(sql, engine, db, time, editorId);
        
        if(editorId === 'b') {
            AppState.gridData = results;
            AppState.gridFiltered = results;
            AppState.currentPage = 1;
            renderPagination();
            switchTab('tab-results');
        } else {
            await refreshExplorer();
        }
    } catch (e) {
        logMessage(e.message, "error");
        switchTab('tab-messages');
    }
}

// Data Grid Phân trang & Tìm kiếm & SAFE RENDER
function renderPagination() {
    const data = AppState.gridFiltered;
    const totalPages = Math.ceil(data.length / AppState.pageSize) || 1;
    document.getElementById('page-info').textContent = `Page ${AppState.currentPage} / ${totalPages} (${data.length} rows)`;
    
    const start = (AppState.currentPage - 1) * AppState.pageSize;
    const pageData = data.slice(start, start + AppState.pageSize);
    
    const container = document.getElementById('grid-results');
    container.innerHTML = '';
    
    if(pageData.length === 0) {
        container.textContent = 'Trống (0 rows)';
        return;
    }
    
    const table = document.createElement('table');
    table.className = 'data-table';
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    
    const trHead = document.createElement('tr');
    Object.keys(pageData[0]).forEach(col => {
        const th = document.createElement('th');
        th.textContent = col; trHead.appendChild(th);
    });
    thead.appendChild(trHead);
    
    pageData.forEach(row => {
        const tr = document.createElement('tr');
        Object.values(row).forEach(val => {
            const td = document.createElement('td');
            if(val === null || val === undefined) { td.textContent = 'NULL'; td.className = 'is-null'; }
            else if(typeof val === 'object') { td.textContent = JSON.stringify(val); } // For PostGIS Raw
            else { td.textContent = val; }
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    
    table.appendChild(thead); table.appendChild(tbody); container.appendChild(table);
}

// ==========================================
// 4. EXPLORER & INSPECTOR
// ==========================================
async function refreshExplorer() {
    const container = document.getElementById('explorer-tree');
    container.innerHTML = '';
    
    const engine = AppState.currentEngine;
    const dbList = AppState.dbLists[engine];
    const activeDb = AppState.activeDBs[engine];
    AppState.schemaMetadata = {}; 
    
    // --- ĐOẠN MỚI THÊM: Hiển thị DB đang kết nối lên Tiêu đề Editor ---
    document.querySelector('#pane-a .pane-title').innerHTML = `<i class="ri-table-line"></i> Editor A (DDL) <span style="color:var(--warning); font-size:11px; margin-left:8px;">[DB: ${activeDb}]</span>`;
    document.querySelector('#pane-b .pane-title').innerHTML = `<i class="ri-code-line"></i> Editor B (Query) <span style="color:var(--warning); font-size:11px; margin-left:8px;">[DB: ${activeDb}]</span>`;
    // ------------------------------------------------------------------

    for(let db of dbList) {
        const dbNode = document.createElement('div');
        dbNode.className = 'tree-db';
        // Đổi màu chữ (Active) cho dễ nhìn
        dbNode.innerHTML = `<i class="ri-database-2-line"></i> ${db} ${db === activeDb ? '<span style="color:var(--success); font-size:11px; margin-left:5px;">(Active)</span>' : ''}`;
        
        // --- ĐOẠN MỚI THÊM: Click vào để chuyển Database ---
        dbNode.onclick = async () => {
            if (AppState.activeDBs[engine] !== db) {
                AppState.activeDBs[engine] = db;
                localStorage.setItem('ide_active_dbs', JSON.stringify(AppState.activeDBs)); // Lưu lại
                await refreshExplorer();
                logMessage(`🔌 Đã kết nối tới Database: ${db}`, "success");
            }
        };
        // ---------------------------------------------------
        
        container.appendChild(dbNode);
        
        if(db === activeDb) {
            const tables = await AppState.adapters[engine].getTables(db);
            for(let t of tables) {
                const schema = await AppState.adapters[engine].getTableSchema(db, t);
                const cols = schema.map(c => c.column_name);
                AppState.schemaMetadata[t] = cols; 
                
                const tNode = document.createElement('div');
                tNode.className = 'tree-table';
                tNode.innerHTML = `<i class="ri-table-line"></i> ${t}`;
                // Ngăn chặn sự kiện click lan lên DB
                tNode.onclick = (e) => { e.stopPropagation(); inspectTable(t, schema); };
                container.appendChild(tNode);
                
                schema.forEach(c => {
                    const cNode = document.createElement('div');
                    cNode.className = `tree-col ${c.is_pk == 1 ? 'pk' : ''}`;
                    cNode.innerHTML = `${c.is_pk == 1 ? '<i class="ri-key-fill"></i>' : '•'} ${c.column_name} <i style="opacity:0.6; margin-left:4px;">(${c.data_type})</i>`;
                    container.appendChild(cNode);
                });
            }
        }
    }
    updateAutocompleteHint();
}

async function inspectTable(tableName, schema) {
    const engine = AppState.currentEngine;
    const db = AppState.activeDBs[engine];
    try {
        // Tab Structure
        const sContainer = document.getElementById('grid-structure');
        sContainer.innerHTML = '';
        const table = document.createElement('table'); table.className = 'data-table';
        table.innerHTML = `<thead><tr><th>Column</th><th>Type</th><th>PK</th><th>Nullable</th><th>Default</th></tr></thead><tbody>
            ${schema.map(c => `<tr><td>${c.column_name}</td><td>${c.data_type}</td><td>${c.is_pk==1?'YES':''}</td><td>${c.is_nullable}</td><td>${c.column_default||''}</td></tr>`).join('')}
        </tbody>`;
        sContainer.appendChild(table);
        
        // Tab Data
        const data = await AppState.adapters[engine].execute(db, `SELECT * FROM ${tableName} LIMIT 100`);
        const dContainer = document.getElementById('grid-data');
        dContainer.innerHTML = '';
        if(data.length > 0) {
            const dt = document.createElement('table'); dt.className = 'data-table';
            const h = `<thead><tr>${Object.keys(data[0]).map(k=>`<th>${k}</th>`).join('')}</tr></thead>`;
            const b = `<tbody>${data.map(r=>`<tr>${Object.values(r).map(v=>`<td>${v!==null?v:'<i class="is-null">NULL</i>'}</td>`).join('')}</tr>`).join('')}</tbody>`;
            dt.innerHTML = h + b; dContainer.appendChild(dt);
        } else {
            dContainer.textContent = 'Bảng trống.';
        }
        
        switchTab('tab-structure');
    } catch(e) { logMessage("Lỗi inspect: " + e.message, "error"); }
}

// ==========================================
// 5. TABLE DESIGNER (STAGE 3)
// ==========================================
let designerCols = [];
function renderDesignerCols() {
    const tbody = document.getElementById('designer-cols-body');
    tbody.innerHTML = '';
    designerCols.forEach((col, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="text" value="${col.name}" onchange="updateCol(${idx}, 'name', this.value)"></td>
            <td>
                <select onchange="updateCol(${idx}, 'type', this.value)">
                    <option ${col.type==='INTEGER'?'selected':''}>INTEGER</option>
                    <option ${col.type==='TEXT'?'selected':''}>TEXT</option>
                    <option ${col.type==='VARCHAR(255)'?'selected':''}>VARCHAR(255)</option>
                    <option ${col.type==='BOOLEAN'?'selected':''}>BOOLEAN</option>
                    <option ${col.type==='DATE'?'selected':''}>DATE</option>
                    <option ${col.type==='GEOMETRY'?'selected':''}>GEOMETRY (PostGIS)</option>
                </select>
            </td>
            <td><input type="checkbox" ${col.pk?'checked':''} onchange="updateCol(${idx}, 'pk', this.checked)"></td>
            <td><input type="checkbox" ${col.notNull?'checked':''} onchange="updateCol(${idx}, 'notNull', this.checked)"></td>
            <td><button class="icon-btn" style="color:var(--danger)" onclick="removeCol(${idx})"><i class="ri-delete-bin-line"></i></button></td>
        `;
        tbody.appendChild(tr);
    });
}
window.updateCol = (idx, key, val) => { designerCols[idx][key] = val; };
window.removeCol = (idx) => { designerCols.splice(idx, 1); renderDesignerCols(); };

document.getElementById('btn-add-col').onclick = () => {
    designerCols.push({ name: 'new_column', type: 'TEXT', pk: false, notNull: false });
    renderDesignerCols();
};
document.getElementById('btn-preview-ddl').onclick = () => {
    const tName = document.getElementById('designer-table-name').value.trim() || 'new_table';
    if(designerCols.length === 0) return alert("Thêm ít nhất 1 cột!");
    
    let engine = AppState.currentEngine;
    let defs = designerCols.map(c => {
        let def = `${c.name} ${c.type}`;
        if(c.pk) {
            // PostgreSQL SERIAL xử lý auto-increment
            if(engine === 'postgres' && c.type === 'INTEGER') def = `${c.name} SERIAL PRIMARY KEY`;
            else def += " PRIMARY KEY";
        }
        if(c.notNull && !c.pk) def += " NOT NULL";
        return def;
    });
    
    const sql = `CREATE TABLE ${tName} (\n    ${defs.join(', \n    ')}\n);`;
    
    // Đẩy DDL sang Editor A và ẩn UI Designer
    AppState.editors.a.setValue(sql);
    document.getElementById('designer-wrapper').style.display = 'none';
    document.getElementById('editor-a-wrapper').style.display = 'flex';
};

// ==========================================
// 6. EXPORT / IMPORT & UTILS
// ==========================================
document.getElementById('btn-export-csv').onclick = () => {
    if(AppState.gridData.length===0) return;
    const header = Object.keys(AppState.gridData[0]).join(',') + '\n';
    const csv = header + AppState.gridData.map(r => Object.values(r).map(v => `"${v}"`).join(',')).join('\n');
    downloadFile(csv, 'results.csv', 'text/csv');
};
document.getElementById('btn-export-json').onclick = () => {
    if(AppState.gridData.length===0) return;
    downloadFile(JSON.stringify(AppState.gridData, null, 2), 'results.json', 'application/json');
};

document.getElementById('btn-export-db').onclick = async () => {
    const engine = AppState.currentEngine;
    const db = AppState.activeDBs[engine];
    const data = await AppState.adapters[engine].exportLogical(db);
    downloadFile(JSON.stringify(data), `${engine}_${db}_backup.json`, 'application/json');
};

document.getElementById('file-import-db').onchange = (e) => {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            if(!data.tables) throw new Error("File không đúng chuẩn Web SQL Studio");
            
            const engine = AppState.currentEngine;
            const db = AppState.activeDBs[engine];
            logMessage(`Bắt đầu khôi phục dữ liệu vào ${db}...`, "info");
            
            for(let t of data.tables) {
                if(t.data.length === 0) continue;
                // Tạo câu CREATE TABLE ngu ngốc từ key của row đầu tiên (Vì logical backup)
                const cols = Object.keys(t.data[0]).map(k => `${k} TEXT`).join(', ');
                await AppState.adapters[engine].execute(db, `CREATE TABLE IF NOT EXISTS ${t.tableName} (${cols})`);
                
                // Insert data
                for(let row of t.data) {
                    const keys = Object.keys(row).join(', ');
                    const vals = Object.values(row).map(v => v===null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`).join(', ');
                    await AppState.adapters[engine].execute(db, `INSERT INTO ${t.tableName} (${keys}) VALUES (${vals})`);
                }
            }
            logMessage("Khôi phục thành công!", "success");
            refreshExplorer();
            document.getElementById('modal-backup').classList.remove('active');
        } catch(err) { alert("Lỗi import: " + err.message); }
    };
    reader.readAsText(file);
};

function downloadFile(content, fileName, mimeType) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mimeType }));
    a.download = fileName; a.click();
}

// ==========================================
// 7. EVENTS & BINDINGS
// ==========================================
function bindEvents() {
    // 1. TÍNH NĂNG ẨN/HIỆN SIDEBAR (Chính là cái bạn đang thiếu)


    const btnTheme = document.getElementById('btn-theme-toggle');
    if (btnTheme) {
        btnTheme.onclick = () => {
            const isLight = document.body.getAttribute('data-theme') === 'light';
            const newTheme = isLight ? 'dark' : 'light';
            
            // CodeMirror Theme
            const cmTheme = isLight ? 'dracula' : 'default';

            if (newTheme === 'light') {
                document.body.setAttribute('data-theme', 'light');
                btnTheme.innerHTML = '<i class="ri-moon-line"></i>'; // Đổi icon sang Mặt trăng
            } else {
                document.body.removeAttribute('data-theme');
                btnTheme.innerHTML = '<i class="ri-sun-line"></i>'; // Đổi icon sang Mặt trời
            }

            // Cập nhật ngay lập tức Theme của CodeMirror
            AppState.editors.a.setOption('theme', cmTheme);
            AppState.editors.b.setOption('theme', cmTheme);
            
            // Lưu vào máy để lần sau load lại vẫn giữ nguyên
            localStorage.setItem('ide_theme', newTheme);
        };
    }
    const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    if (btnToggleSidebar) {
        btnToggleSidebar.onclick = () => {
            document.getElementById('sidebar').classList.toggle('collapsed');
        };
    }

    // Engine switcher
    document.getElementById('engine-select').onchange = async (e) => {
        AppState.currentEngine = e.target.value; await refreshExplorer();
        logMessage(`Chuyển sang Engine: ${e.target.value}`, "info");
    };
    
    // UI Toggles (Bật tắt UI Designer)
    document.getElementById('btn-toggle-designer').onclick = () => {
        const wrapper = document.getElementById('designer-wrapper');
        const editorWrapper = document.getElementById('editor-a-wrapper');
        if(wrapper.style.display === 'none') {
            wrapper.style.display = 'flex'; editorWrapper.style.display = 'none';
        } else {
            wrapper.style.display = 'none'; editorWrapper.style.display = 'flex';
        }
    };
    
    // Run buttons
    document.getElementById('btn-run-ddl').onclick = () => runQuery('a');
    document.getElementById('btn-run-query').onclick = () => runQuery('b');
    document.getElementById('btn-refresh-explorer').onclick = refreshExplorer;
    document.getElementById('btn-format-sql').onclick = () => {
        let val = AppState.editors.b.getValue();
        const keywords = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'ORDER BY', 'LIMIT', 'JOIN', 'ON', 'GROUP BY'];
        keywords.forEach(kw => { val = val.replace(new RegExp(`\\b${kw}\\b`, 'gi'), kw); });
        AppState.editors.b.setValue(val);
    };
    
    // DB Creation
    // DB Creation (Giữ nguyên logic Regex và Prompt cũ)
    document.getElementById('btn-new-db').onclick = async () => {
        let name = prompt(`Nhập tên Database mới cho ${AppState.currentEngine.toUpperCase()}:`);
        if (name) {
            name = name.trim().toLowerCase();
            
            // Validate bằng Regex hệt như code cũ
            if (/^[a-z0-9_]+$/.test(name)) {
                if (AppState.dbLists[AppState.currentEngine].includes(name)) {
                    return alert("Database đã tồn tại trong Engine này!");
                }
                
                AppState.dbLists[AppState.currentEngine].push(name);
                AppState.activeDBs[AppState.currentEngine] = name;
                
                // Lưu trạng thái
                localStorage.setItem('ide_db_lists', JSON.stringify(AppState.dbLists));
                localStorage.setItem('ide_active_dbs', JSON.stringify(AppState.activeDBs));
                
                // Khởi tạo và báo thành công
                await AppState.adapters[AppState.currentEngine].createDB(name);
                await refreshExplorer();
                logMessage(`Đã tạo Database: ${name}`, "success");
            } else {
                alert("Tên không hợp lệ! Chỉ dùng chữ cái, số và dấu gạch dưới.");
            }
        }
    };
    
    // Pagination & Search
    document.getElementById('btn-prev-page').onclick = () => { if(AppState.currentPage > 1) { AppState.currentPage--; renderPagination(); }};
    document.getElementById('btn-next-page').onclick = () => { if(AppState.currentPage * AppState.pageSize < AppState.gridFiltered.length) { AppState.currentPage++; renderPagination(); }};
    document.getElementById('search-results').oninput = (e) => {
        const q = e.target.value.toLowerCase();
        AppState.gridFiltered = AppState.gridData.filter(row => Object.values(row).some(v => String(v).toLowerCase().includes(q)));
        AppState.currentPage = 1; renderPagination();
    };
    
    // Modals & Tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.onclick = (e) => switchTab(e.currentTarget.dataset.target);
    });
    document.getElementById('btn-backup').onclick = () => document.getElementById('modal-backup').classList.add('active');
    document.getElementById('btn-history').onclick = () => { renderHistory(); document.getElementById('modal-history').classList.add('active'); };
    document.querySelectorAll('.close-modal').forEach(btn => {
        btn.onclick = (e) => e.target.closest('.modal-overlay').classList.remove('active');
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    document.querySelector(`.tab-btn[data-target="${tabId}"]`).classList.add('active');
    document.getElementById(tabId).classList.add('active');
}

function logMessage(msg, type) {
    const log = document.getElementById('log-messages');
    log.innerHTML += `\n<span class="log-${type}">[${new Date().toLocaleTimeString()}] ${msg}</span>`;
    log.scrollTop = log.scrollHeight;
}

function saveHistory(sql, engine, db, time, originEditor) {
    // Thêm trường 'origin' vào object lịch sử
    AppState.queryHistory.unshift({ 
        sql, 
        engine, 
        db, 
        time, 
        date: new Date().toLocaleString(),
        origin: originEditor || 'b' // Mặc định là 'b' cho các lịch sử cũ chưa có tag
    });
    
    if(AppState.queryHistory.length > 50) AppState.queryHistory.pop();
    localStorage.setItem('ide_history', JSON.stringify(AppState.queryHistory));
}
function renderHistory() {
    const list = document.getElementById('history-list'); 
    list.innerHTML = '';
    
    AppState.queryHistory.forEach(h => {
        const li = document.createElement('li'); 
        li.className = 'history-item';
        
        // Gắn thêm cái nhãn nhỏ để user biết code này từ ô nào
        const badge = h.origin === 'a' ? '<span style="color:#b89500">[Editor A]</span>' : '<span style="color:#0e639c">[Editor B]</span>';
        
        li.innerHTML = `
            <div class="history-sql">${h.sql}</div>
            <div class="history-meta">
                <span>${badge} ${h.engine} -> ${h.db}</span>
                <span>${h.date} (${h.time}ms)</span>
            </div>
        `;
        
        li.onclick = () => { 
            // Đọc lại tag origin, trả về đúng editor đó
            const targetEditor = h.origin || 'b';
            
            if (targetEditor === 'a') {
                AppState.editors.a.setValue(h.sql);
                // Đảm bảo đang mở chế độ Code chứ không phải UI Designer
                document.getElementById('designer-wrapper').style.display = 'none';
                document.getElementById('editor-a-wrapper').style.display = 'flex';
                logMessage("Đã khôi phục lệnh vào Editor A", "info");
            } else {
                AppState.editors.b.setValue(h.sql);
                logMessage("Đã khôi phục lệnh vào Editor B", "info");
            }
            
            document.getElementById('modal-history').classList.remove('active'); 
        };
        
        list.appendChild(li);
    });
}

function setupResizers() {
    // 1. Logic kéo dọc (Chia tỷ lệ Editor A và B) - Giữ nguyên
    const resizerV = document.getElementById('resizer-v');
    const paneA = document.getElementById('pane-a');
    let isDraggingV = false;
    resizerV.addEventListener('mousedown', () => { isDraggingV = true; document.body.style.cursor = 'col-resize'; });
    document.addEventListener('mousemove', (e) => {
        if(!isDraggingV) return;
        const newWidth = (e.clientX - paneA.getBoundingClientRect().left) / document.getElementById('editors-container').offsetWidth * 100;
        if(newWidth > 10 && newWidth < 90) paneA.style.flex = `0 0 ${newWidth}%`;
    });
    document.addEventListener('mouseup', () => { if(isDraggingV){ isDraggingV = false; document.body.style.cursor = 'default'; }});

    // 2. Logic kéo ngang (Chiều cao Editor và Khung Result) - SỬA LẠI CHỖ NÀY
    const resizerH = document.getElementById('resizer-h');
    const editorsContainer = document.getElementById('editors-container');
    let isDraggingH = false;
    resizerH.addEventListener('mousedown', () => { isDraggingH = true; document.body.style.cursor = 'row-resize'; });
    document.addEventListener('mousemove', (e) => {
        if(!isDraggingH) return;
        
        // Tính toán chiều cao mới
        const newHeight = e.clientY - editorsContainer.getBoundingClientRect().top;
        
        // Giới hạn kéo: Không cho kéo quá sát trên cùng hoặc dưới cùng
        if(newHeight > 100 && newHeight < window.innerHeight - 100) {
            editorsContainer.style.flex = 'none'; // <--- DÒNG QUAN TRỌNG ĐÃ THÊM: Tắt flex để height cứng có tác dụng
            editorsContainer.style.height = `${newHeight}px`;
        }
    });
    document.addEventListener('mouseup', () => { if(isDraggingH){ isDraggingH = false; document.body.style.cursor = 'default'; }});
}

window.onload = initSystem;