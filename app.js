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
    async getForeignKeys(dbName) { return []; }
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

    // <-- THÊM HÀM NÀY VÀO TRONG CLASS PGAdapter -->
    async getForeignKeys(dbName) {
        try {
            // Truy vấn lấy danh sách bảng cha - bảng con trong PostgreSQL
            const rows = await this.execute(dbName, `
                SELECT
                    tc.table_name AS from_table,
                    ccu.table_name AS to_table
                FROM information_schema.table_constraints AS tc
                JOIN information_schema.constraint_column_usage AS ccu
                  ON ccu.constraint_name = tc.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY' 
                  AND tc.table_schema = 'public'
            `);
            return rows;
        } catch(e) { 
            return []; 
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
let mapInstance = null;
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
    rowsPerPage: 50,
};

async function initSystem() {
    logMessage("Khởi tạo hệ thống...", "info");
    await AppState.adapters.sqlite.init();

    // Khôi phục Theme từ Dropdown
    const savedTheme = localStorage.getItem('ide_theme') || 'dracula';
    const themeSelect = document.getElementById('theme-select');
    if (themeSelect) {
        themeSelect.onchange = (e) => {
            applyTheme(e.target.value);
            logMessage("Đã đổi Theme thành: " + e.target.value.toUpperCase(), "info");
        };
    }
    if (themeSelect) themeSelect.value = savedTheme;
    applyTheme(savedTheme);
    
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
    mermaid.initialize({ startOnLoad: false, theme: 'default' }); // THÊM DÒNG NÀY
    
    logMessage("Hệ thống sẵn sàng!", "success");
}
function initEditors() {
    const cmTheme = localStorage.getItem('ide_theme') || 'dracula';

    // Khai báo một hàm xử lý Enter thông minh
    // Khai báo hàm xử lý Enter thông minh (Chuẩn VS Code)
    const smartEnter = function(cm) {
        const cur = cm.getCursor();
        const line = cm.getLine(cur.line);
        
        // Nếu con trỏ đang nằm kẹp giữa '(' và ')'
        if (line.charAt(cur.ch - 1) === '(' && line.charAt(cur.ch) === ')') {
            // Dùng cm.operation để gộp các bước lại, giúp màn hình không bị giật (flicker)
            cm.operation(() => {
                cm.execCommand("newlineAndIndent"); // Bước 1: Ấn Enter lần 1 (Đẩy ')' xuống dòng 2)
                const middlePos = cm.getCursor();   // Bước 2: Lưu vị trí con trỏ tại dòng 2
                cm.execCommand("newlineAndIndent"); // Bước 3: Ấn Enter lần 2 (Đẩy ')' xuống dòng 3)
                cm.setCursor(middlePos);            // Bước 4: Vòng con trỏ ngược trở lại dòng 2
                cm.execCommand("indentMore");       // Bước 5: Thụt lề (Tab) cho dòng 2
            });
        } else {
            // Nếu gõ Enter ở chỗ khác thì ngắt dòng bình thường
            cm.execCommand("newlineAndIndent"); 
        }
    };
    const config = { 
        mode: "text/x-mega-sql", // Giữ nguyên Mode SQL độ chế ban nãy
        theme: cmTheme, 
        lineNumbers: true, 
        matchBrackets: true,
        autoCloseBrackets: true, // <-- Bật tính năng gõ 1 ra 2 (ngoặc, nháy đơn, nháy kép)
        smartIndent: true,       // <-- Bật tự động nhận diện thụt lề
        indentUnit: 4,
        lineWrapping: true,
        extraKeys: {
            "Enter": smartEnter
        }       // <-- Quy định mỗi lần thụt lề là 4 khoảng trắng
    };

    // 1. ĐẢM BẢO OBJECT TỒN TẠI VÀ TẠO EDITOR TRƯỚC (Bắt buộc)
    if (!AppState.editors) AppState.editors = {};
    
    AppState.editors.a = CodeMirror.fromTextArea(document.getElementById("editor-a"), config);
    AppState.editors.b = CodeMirror.fromTextArea(document.getElementById("editor-b"), {
        ...config, 
        extraKeys: { 
            ...config.extraKeys,
            "Ctrl-Space": "autocomplete",
            "F5": () => runQuery('b'), 
            "Ctrl-Enter": () => runQuery('b'),
            "Ctrl-/": "toggleComment"
        }
    });

    // 2. GẮN SỰ KIỆN GÕ PHÍM ĐỂ HIỆN GỢI Ý (Đã nâng cấp độ nhạy)
    const autoSuggest = function (cm, event) {
        // Bỏ qua các phím điều hướng (Lên, Xuống, Trái, Phải, Enter, Esc)
        const ignores = [13, 27, 37, 38, 39, 40];
        if (ignores.includes(event.keyCode)) return;

        // Kích hoạt khi gõ chữ (A-Z), số (0-9), dấu chấm (.) và cả nút Xóa lùi (Backspace: 8)
        if (!cm.state.completionActive && 
           ((event.keyCode >= 48 && event.keyCode <= 90) || event.keyCode === 190 || event.keyCode === 8)) {
            CodeMirror.commands.autocomplete(cm, null, { completeSingle: false });
        }
    };
    
    AppState.editors.a.on("keyup", autoSuggest);
    AppState.editors.b.on("keyup", autoSuggest);

    // 3. GẮN SỰ KIỆN TỰ ĐỘNG LƯU CODE KHI GÕ (Auto-save)
    AppState.editors.a.on('change', () => localStorage.setItem('draft_sql_a', AppState.editors.a.getValue()));
    AppState.editors.b.on('change', () => localStorage.setItem('draft_sql_b', AppState.editors.b.getValue()));

    // 4. KHÔI PHỤC CODE HOẶC ĐỌC TỪ LINK SHARE SAU KHI EDITOR ĐÃ SẴN SÀNG
    const urlHash = window.location.hash;
    if (urlHash && urlHash.startsWith('#code=')) {
        try {
            const sharedCode = decodeURIComponent(escape(atob(urlHash.replace('#code=', ''))));
            AppState.editors.b.setValue(sharedCode);
            window.location.hash = ''; 
            logMessage("Đã tải mã SQL từ link chia sẻ!", "success");
        } catch(e) { logMessage("Link chia sẻ bị lỗi!", "error"); }
    } else {
        const savedA = localStorage.getItem('draft_sql_a');
        const savedB = localStorage.getItem('draft_sql_b');
        if (savedA) AppState.editors.a.setValue(savedA);
        if (savedB) AppState.editors.b.setValue(savedB);
    }
}

// --- BÊ TỪ CODE CŨ: Hàm phân tích gợi ý thông minh ---
// function customSQLHint(editor, options) {
//     const cur = editor.getCursor(); 
//     const curLine = editor.getLine(cur.line);
//     let start = cur.ch, end = start;
    
//     while (end < curLine.length && /[\w\.]/.test(curLine.charAt(end))) ++end;
//     while (start && /[\w\.]/.test(curLine.charAt(start - 1))) --start;
    
//     const curWord = curLine.slice(start, end).toLowerCase();
//     const tables = options.tables || {};
    
    
//     if (curWord.includes('.')) {
//         let parts = curWord.split('.');
//         let tName = parts[0], searchCol = parts[1];
//         let matchedTable = Object.keys(tables).find(t => t.toLowerCase() === tName);
//         if (matchedTable) {
//             let matches = tables[matchedTable].filter(col => col.toLowerCase().includes(searchCol));
//             return { list: matches, from: CodeMirror.Pos(cur.line, start + tName.length + 1), to: CodeMirror.Pos(cur.line, end) };
//         }
//     }
    
//     let suggestions = ["SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "CREATE", "TABLE", "UPDATE", "SET", "DELETE", "ORDER BY", "GROUP BY", "AND", "OR", "LIMIT", "JOIN"];
//     const fullText = editor.getValue().toLowerCase(); 
//     let contextColumns = [], otherColumns = [];

    
//     for (let tableName in tables) {
//         if (!suggestions.includes(tableName)) suggestions.push(tableName);
//         let isTableInUse = fullText.includes(tableName.toLowerCase());
//         tables[tableName].forEach(col => {
//             if (isTableInUse) { 
//                 if (!contextColumns.includes(col)) contextColumns.push(col); 
//             } else { 
//                 if (!otherColumns.includes(col)) otherColumns.push(col); 
//             }
//         });
//     }

//     let matches = [...contextColumns, ...suggestions, ...otherColumns].filter(word => word.toLowerCase().includes(curWord));
//     return { list: matches, from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, end) };
// }

// --- CẬP NHẬT LẠI: Dùng bộ từ điển khổng lồ mặc định của CodeMirror ---
// function updateAutocompleteHint() {
//     const hintConfig = { 
//         tables: AppState.schemaMetadata, 
//         disableErrors: true,
//         completeSingle: false 
//     };
//     AppState.editors.a.setOption("hintOptions", hintConfig);
//     AppState.editors.b.setOption("hintOptions", hintConfig);
// }
// ==========================================
// TỪ ĐIỂN SQL THÔNG MINH - CHIA THEO ENGINE
// ==========================================
const SQL_DICTS = {
    common: [
        "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", 
        "CREATE", "ALTER", "DROP", "TABLE", "INDEX", "VIEW", "TRIGGER", "DATABASE", "SCHEMA",
        "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "FULL", "CROSS", "ON", "USING",
        "ORDER BY", "GROUP BY", "HAVING", "LIMIT", "OFFSET",
        "UNION", "INTERSECT", "EXCEPT", "ALL", "DISTINCT", "AS", "ASC", "DESC", "NULL", "IS", "NOT", "AND", "OR",
        "TRUE", "FALSE", "BETWEEN", "LIKE", "IN", "EXISTS", "ANY", "SOME",
        "CASE", "WHEN", "THEN", "ELSE", "END",
        "CAST", "COALESCE", "NULLIF", "GREATEST", "LEAST",
        "COUNT", "SUM", "AVG", "MIN", "MAX",
        "ABS", "CEIL", "FLOOR", "ROUND", "TRUNC",
        "CONCAT", "LENGTH", "SUBSTRING", "LOWER", "UPPER", "TRIM", "REPLACE",
        "INT", "INTEGER", "SMALLINT", "BIGINT", "NUMERIC", "DECIMAL", "REAL", "FLOAT",
        "VARCHAR", "CHAR", "TEXT", "BOOLEAN", "DATE", "TIME", "TIMESTAMP",
        "PRIMARY KEY", "FOREIGN KEY", "REFERENCES", "UNIQUE", "CHECK", "DEFAULT", "NOT NULL"
    ],
    postgres: [
        "SERIAL", "BIGSERIAL", "JSON", "JSONB", "UUID", "BYTEA", "GEOMETRY", "GEOGRAPHY", 
        "TIMESTAMPTZ", "INTERVAL", "ILIKE", "RETURNING", "WITH", "RECURSIVE",
        "OVER", "PARTITION BY", "WINDOW", "FETCH", "NEXT", "ROWS", "ONLY",
        "STRING_AGG", "ARRAY_AGG", "JSON_AGG", "JSONB_AGG",
        "NOW()", "CURRENT_DATE", "CURRENT_TIMESTAMP", "EXTRACT", "DATE_TRUNC", "AGE",
        "TO_CHAR", "TO_DATE", "TO_TIMESTAMP", "SPLIT_PART", "POSITION",
        "ST_AsText", "ST_AsGeoJSON", "ST_GeomFromText", "ST_MakePoint", "ST_Distance", 
        "ST_Area", "ST_Length", "ST_Contains", "ST_Intersects", "ST_Buffer", 
        "ST_Centroid", "ST_Intersection", "ST_Union", "ST_Transform", "ST_SetSRID"
    ],
    mysql: [
        "TINYINT", "MEDIUMINT", "AUTO_INCREMENT", "DATETIME", "YEAR",
        "TINYTEXT", "MEDIUMTEXT", "LONGTEXT", "BLOB", "TINYBLOB", "MEDIUMBLOB", "LONGBLOB", "ENUM", "SET",
        "IFNULL", "ISNULL", "GROUP_CONCAT", "CONCAT_WS",
        "DATE_ADD", "DATE_SUB", "DATEDIFF", "SYSDATE", "RAND"
    ],
    sqlite: [
        "AUTOINCREMENT", "PRAGMA", "GLOB", "ATTACH", "DETACH", "VACUUM",
        "IFNULL", "STRFTIME", "INSTR", "RANDOM"
    ]
};

function ultimateSQLHint(editor, options) {
    const cur = editor.getCursor(); 
    const curLine = editor.getLine(cur.line);
    let start = cur.ch, end = start;
    
    while (end < curLine.length && /[\w\.]/.test(curLine.charAt(end))) ++end;
    while (start && /[\w\.]/.test(curLine.charAt(start - 1))) --start;
    
    const curWord = curLine.slice(start, end).toLowerCase();
    if (!curWord) return { list: [], from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, end) };
    
    if (curWord.includes('.')) {
        let parts = curWord.split('.');
        let tName = parts[0], searchCol = parts[1] || '';
        let matchedTable = Object.keys(AppState.schemaMetadata).find(t => t.toLowerCase() === tName);
        if (matchedTable) {
            let matches = AppState.schemaMetadata[matchedTable].filter(col => col.toLowerCase().includes(searchCol));
            return { list: matches, from: CodeMirror.Pos(cur.line, start + tName.length + 1), to: CodeMirror.Pos(cur.line, end) };
        }
        return { list: [], from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, end) };
    }
    
    let dbTables = Object.keys(AppState.schemaMetadata);
    let dbColumns = [];
    dbTables.forEach(t => {
        AppState.schemaMetadata[t].forEach(c => {
            if(!dbColumns.includes(c)) dbColumns.push(c);
        });
    });

    const engine = AppState.currentEngine; 
    const engineKeywords = SQL_DICTS[engine] || []; 
    
    let allCandidates = [...dbTables, ...dbColumns, ...SQL_DICTS.common, ...engineKeywords];
    let matches = allCandidates.filter(word => word.toLowerCase().includes(curWord));
    
    matches.sort((a, b) => {
        let aStarts = a.toLowerCase().startsWith(curWord) ? -1 : 1;
        let bStarts = b.toLowerCase().startsWith(curWord) ? -1 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.localeCompare(b);
    });

    matches = [...new Set(matches)];

    // --- BẮT ĐẦU ĐOẠN CODE FIX GIAO DIỆN (SẠCH, TINH TẾ, DỄ NHÌN) ---
    const formattedMatches = matches.map(word => {
        return {
            text: word, 
            render: function(element, data, cur) {
                const matchIndex = word.toLowerCase().indexOf(curWord.toLowerCase());
                element.innerHTML = ""; 
                
                if (matchIndex >= 0 && curWord.length > 0) {
                    const before = word.substring(0, matchIndex);
                    const matched = word.substring(matchIndex, matchIndex + curWord.length);
                    const after = word.substring(matchIndex + curWord.length);
                    
                    // 1. Chữ phía trước (Sẽ tự động có màu đen trên nền trắng, hoặc trắng trên nền đen)
                    element.appendChild(document.createTextNode(before));
                    
                    // 2. CHỮ ĐANG GÕ: Chỉ tô đậm và dùng màu Tím Đậm (Dễ đọc trên cả 2 nền)
                    const spanMatch = document.createElement("span");
                    spanMatch.style.cssText = `color: #d23669 !important; font-weight: bold !important;`;
                    spanMatch.innerText = matched;
                    element.appendChild(spanMatch);
                    
                    // 3. Chữ phía sau (Tự động theo màu mặc định)
                    element.appendChild(document.createTextNode(after));
                } else {
                    // Nếu xổ ra không qua gõ phím
                    element.innerText = word;
                }
            }
        };
    });

    return { list: formattedMatches, from: CodeMirror.Pos(cur.line, start), to: CodeMirror.Pos(cur.line, end) };
    // --- KẾT THÚC ĐOẠN CODE ---
}

// ==========================================
// ÉP TÔ MÀU CÚ PHÁP (SYNTAX HIGHLIGHTING) BÊN TRONG EDITOR
// ==========================================
function updateSyntaxHighlighting() {
    if (!AppState.editors.a || !AppState.editors.b) return;

    const engine = AppState.currentEngine;
    // Lấy toàn bộ từ điển theo Engine hiện tại
    const words = [...SQL_DICTS.common, ...(SQL_DICTS[engine] || [])];
    
    let keywordsObj = {};
    let builtinsObj = {};
    
    words.forEach(w => {
        const word = w.toLowerCase(); // CodeMirror yêu cầu viết thường
        
        // Phân loại Hàm / Kiểu dữ liệu (Màu Vàng / Xanh) vs Từ khóa (Màu Tím)
        const isFunc = /^(st_|to_|date_|json_|string_|array_)|(count|sum|avg|min|max|coalesce|concat|substring|round|now|extract|replace|length|greatest|least|abs|ceil|floor)/i.test(w);
        const isType = /^(int|varchar|text|boolean|date|timestamp|json|geometry|serial|float|decimal|char|numeric)/i.test(w);
        
        if (isFunc || isType) builtinsObj[word] = true;
        else keywordsObj[word] = true;
    });

    // Tạo ra một Mode SQL "độ chế" mang tên text/x-mega-sql
    CodeMirror.defineMIME("text/x-mega-sql", {
        name: "sql",
        keywords: keywordsObj,
        builtin: builtinsObj,
        atoms: {"null": true, "true": true, "false": true}
    });

    // Áp dụng ngay cho 2 ô Editor để nó thay đổi màu lập tức
    AppState.editors.a.setOption("mode", "text/x-mega-sql");
    AppState.editors.b.setOption("mode", "text/x-mega-sql");
}
function updateAutocompleteHint() {
    const hintConfig = { hint: ultimateSQLHint };
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

 // Lưu dữ liệu đang sửa { rowIndex: { oldRow, newRow } }

let currentSortCol = null;
let currentSortAsc = true;
let editedRowsMap = new Map(); 

function renderPagination(page = AppState.currentPage) {
    const tbody = document.getElementById('grid-results');
    
    try {
        tbody.innerHTML = '';
        
        // 1. Kiểm tra an toàn dữ liệu
        if (!AppState.gridData || !Array.isArray(AppState.gridData) || AppState.gridData.length === 0) {
            tbody.innerHTML = '<i style="color: var(--success); padding: 10px; display: block;">✅ Lệnh thực thi thành công. Không có dữ liệu trả về (0 rows).</i>';
            return;
        }

        // 2. Tính toán phân trang an toàn (Đề phòng AppState.rowsPerPage bị undefined)
        const limit = AppState.rowsPerPage || 50; 
        const start = (page - 1) * limit;
        const end = start + limit;
        const pageData = AppState.gridData.slice(start, end);

        if (pageData.length === 0 || !pageData[0]) {
            tbody.innerHTML = '<i style="color: var(--text-muted); padding: 10px; display: block;">Không có dữ liệu ở trang này.</i>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'data-table';
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        
        // 3. Bắt tên bảng cực kỳ an toàn
        let targetTable = null;
        if (AppState.editors && AppState.editors.b) {
            const sql = AppState.editors.b.getValue().replace(/\s+/g, ' ').toUpperCase();
            const tableMatch = /FROM\s+([A-Z0-9_]+)/i.exec(sql);
            if (tableMatch) targetTable = tableMatch[1];
        }
        
        // 4. Lọc & Sắp xếp Header
        Object.keys(pageData[0]).forEach(key => {
            const th = document.createElement('th');
            th.textContent = key;
            
            if (currentSortCol === key) {
                th.classList.add(currentSortAsc ? 'sort-asc' : 'sort-desc');
            }

            th.onclick = () => {
                currentSortAsc = currentSortCol === key ? !currentSortAsc : true;
                currentSortCol = key;
                
                AppState.gridData.sort((a, b) => {
                    let valA = a[key], valB = b[key];
                    if(valA === null) valA = ''; if(valB === null) valB = '';
                    if(typeof valA === 'number' && typeof valB === 'number') return currentSortAsc ? valA - valB : valB - valA;
                    return currentSortAsc ? String(valA).localeCompare(String(valB)) : String(valB).localeCompare(String(valA));
                });
                renderPagination(1);
            };
            trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        table.appendChild(thead);

        // 5. Render Dữ liệu
        const tbodyData = document.createElement('tbody');
        pageData.forEach((row, index) => {
            const tr = document.createElement('tr');
            const absoluteIndex = start + index; 
            
            Object.entries(row).forEach(([colKey, val]) => {
                const td = document.createElement('td');
                
                if (val === null || val === undefined) { 
                    td.textContent = 'NULL'; 
                    td.className = 'is-null'; 
                }
                else if (val instanceof Date) { 
                    let dStr = val.toISOString().replace('T', ' ').substring(0, 19);
                    if (dStr.endsWith(' 00:00:00')) dStr = dStr.substring(0, 10);
                    td.textContent = dStr; 
                }
                else if (typeof val === 'object') { 
                    td.textContent = JSON.stringify(val); 
                } 
                else { 
                    let strVal = String(val);
                    // 1. Cắt đuôi giờ phút giây rỗng
                    if (strVal.endsWith(' 00:00:00')) strVal = strVal.replace(' 00:00:00', '');
                    else if (strVal.endsWith('T00:00:00.000Z')) strVal = strVal.substring(0, 10);
                    
                    // 2. Cắt đuôi số thập phân vô nghĩa (ví dụ: "5000.00" -> "5000", "12.000" -> "12")
                    // Dùng Regex kiểm tra xem chuỗi có kết thúc bằng .0000... không
                    if (/^-?\d+\.0+$/.test(strVal)) {
                        strVal = strVal.split('.')[0]; 
                    }
                    
                    td.textContent = strVal; 
                }
                
                // Inline Edit
                if (targetTable) { 
                    td.ondblclick = () => {
                        td.setAttribute('contenteditable', 'true');
                        td.focus();
                    };
                    
                    td.onblur = () => {
                        td.removeAttribute('contenteditable');
                        const newVal = td.textContent === 'NULL' ? null : td.textContent;
                        if (String(newVal) !== String(val)) {
                            td.classList.add('edited-cell');
                            document.getElementById('btn-save-inline').style.display = 'inline-flex';
                            
                            if(!editedRowsMap.has(absoluteIndex)) {
                                editedRowsMap.set(absoluteIndex, { oldRow: {...row}, newRow: {...row} });
                            }
                            editedRowsMap.get(absoluteIndex).newRow[colKey] = newVal;
                        }
                    };
                }
                tr.appendChild(td);
            });
            tbodyData.appendChild(tr);
        });
        
        table.appendChild(tbodyData);
        tbody.appendChild(table);
        
        // 6. Gắn sự kiện nút Lưu Inline
        const btnSave = document.getElementById('btn-save-inline');
        if (btnSave) {
            btnSave.onclick = async () => {
                if(!targetTable) return;
                const engine = AppState.currentEngine;
                const db = AppState.activeDBs[engine];
                let successCount = 0;
                
                try {
                    for (let [idx, data] of editedRowsMap.entries()) {
                        const { oldRow, newRow } = data;
                        const setParams = Object.keys(newRow).filter(k => newRow[k] !== oldRow[k]).map(k => `${k} = '${newRow[k]}'`).join(', ');
                        const whereParams = Object.keys(oldRow).filter(k => oldRow[k] !== null && typeof oldRow[k] !== 'object').map(k => `${k} = '${oldRow[k]}'`).join(' AND ');
                        const updateSQL = `UPDATE ${targetTable} SET ${setParams} WHERE ${whereParams}`;
                        await AppState.adapters[engine].execute(db, updateSQL);
                        successCount++;
                    }
                    logMessage(`Đã cập nhật ngầm thành công ${successCount} dòng!`, "success");
                    editedRowsMap.clear();
                    btnSave.style.display = 'none';
                    document.getElementById('btn-run-query').click(); 
                    
                } catch(err) {
                    logMessage("Lỗi khi lưu Inline: " + err.message, "error");
                }
            };
        }

    } catch (err) {
        // NẾU CÓ LỖI, IN THẲNG RA MÀN HÌNH MÀU ĐỎ ĐỂ DỄ DÀNG FIX!
        tbody.innerHTML = `<i style="color: var(--danger); padding: 10px; display: block;">❌ Lỗi Javascript: ${err.message}</i>`;
        console.error(err);
    }
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
        // dbNode.onclick = async () => {
        //     if (AppState.activeDBs[engine] !== db) {
        //         AppState.activeDBs[engine] = db;
        //         localStorage.setItem('ide_active_dbs', JSON.stringify(AppState.activeDBs)); 
        //         await refreshExplorer();
        //         logMessage(`🔌 Đã kết nối tới Database: ${db}`, "success");
        //     }
        // };

        // Click trái để chuyển Database
        dbNode.onclick = async () => {
            if (AppState.activeDBs[engine] !== db) {
                AppState.activeDBs[engine] = db;
                localStorage.setItem('ide_active_dbs', JSON.stringify(AppState.activeDBs)); 
                await refreshExplorer();
                if(window.loadCodeForCurrentDB) loadCodeForCurrentDB();
                logMessage(`🔌 Đã kết nối tới Database: ${db}`, "success");
            }
        };
        // ---------------------------------------------------

        // --- TÍNH NĂNG MỚI: CHUỘT PHẢI HIỆN MENU XÓA DB ---
        dbNode.oncontextmenu = (e) => {
            e.preventDefault(); // Chặn menu mặc định của trình duyệt
            
            // Xóa menu cũ nếu đang mở
            const oldMenu = document.getElementById('db-context-menu');
            if (oldMenu) oldMenu.remove();

            // Tạo menu chuột phải mới
            const menu = document.createElement('div');
            menu.id = 'db-context-menu';
            menu.style.display = 'block';
            menu.style.left = `${e.pageX}px`;
            menu.style.top = `${e.pageY}px`;
            
            menu.innerHTML = `
                <div class="menu-item" id="ctx-delete-db">
                    <i class="fa-solid fa-trash-can"></i> Xóa Database (${db})
                </div>
            `;
            
            document.body.appendChild(menu);

            // Xử lý khi bấm nút Xóa trên Menu
            document.getElementById('ctx-delete-db').onclick = async () => {
                menu.remove();
                
                // Kích hoạt logic xóa Database (tương tự như nút thùng rác trên Header)
                const warning = `CẢNH BÁO: Bạn có chắc chắn muốn xóa vĩnh viễn Database '${db}' không?\n\nToàn bộ bảng, dữ liệu và lệnh SQL trong Database này sẽ bị bốc hơi!`;
                if (!confirm(warning)) return;

                if (window.showLoader) showLoader(`Đang xóa Database '${db}'...`);
                await new Promise(resolve => setTimeout(resolve, 50));
                
                try {
                    AppState.dbLists[engine] = AppState.dbLists[engine].filter(item => item !== db);
                    
                    if (AppState.dbLists[engine].length === 0) {
                        const defaultDb = engine === 'sqlite' ? 'main' : 'public';
                        AppState.dbLists[engine].push(defaultDb);
                        await AppState.adapters[engine].createDB(defaultDb);
                    }
                    
                    if (AppState.activeDBs[engine] === db) {
                        AppState.activeDBs[engine] = AppState.dbLists[engine][0];
                    }
                    
                    localStorage.setItem('ide_db_lists', JSON.stringify(AppState.dbLists));
                    localStorage.setItem('ide_active_dbs', JSON.stringify(AppState.activeDBs));
                    
                    localStorage.removeItem(`draft_${engine}_${db}_a`);
                    localStorage.removeItem(`draft_${engine}_${db}_b`);
                    
                    if (engine === 'mysql') alasql(`DROP DATABASE IF EXISTS ${db}`);
                    if (engine === 'sqlite') delete AppState.adapters.sqlite.instances[db];
                    if (engine === 'postgres' && AppState.adapters.postgres.instances[db]) {
                        if (typeof AppState.adapters.postgres.instances[db].close === 'function') {
                            await AppState.adapters.postgres.instances[db].close();
                        }
                        delete AppState.adapters.postgres.instances[db];
                    }

                    await refreshExplorer();
                    if(window.loadCodeForCurrentDB) loadCodeForCurrentDB();
                    else { AppState.editors.a.setValue(''); AppState.editors.b.setValue(''); }
                    
                    logMessage(`🗑️ Đã xóa thành công Database '${db}'`, "success");
                } catch(err) {
                    alert("Lỗi khi xóa Database: " + err.message);
                } finally {
                    if (window.hideLoader) hideLoader();
                }
            };

            // Click ra chỗ khác thì tự động ẩn Menu đi
            const closeMenu = () => {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 10);
        };
        
        container.appendChild(dbNode);
        
        if(db === activeDb) {
            const tables = await AppState.adapters[engine].getTables(db);
            for(let t of tables) {
                const schema = await AppState.adapters[engine].getTableSchema(db, t);
                const cols = schema.map(c => c.column_name);
                AppState.schemaMetadata[t] = cols; 
                
                const tNode = document.createElement('div');
                tNode.className = 'tree-table';
                tNode.innerHTML = `
                    <span><i class="fa-solid fa-table"></i> ${t}</span>
                    <span class="table-actions">
                        <i class="fa-solid fa-bolt" onclick="event.stopPropagation(); window.genSQL('${t}', 'SELECT')" title="Tạo lệnh SELECT"></i>
                        <i class="fa-solid fa-plus" onclick="event.stopPropagation(); window.genSQL('${t}', 'INSERT')" title="Tạo lệnh INSERT"></i>
                    </span>
                `;
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
    updateSyntaxHighlighting();
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
        
        // Hàm format riêng cho Table Data
        const formatVal = (v) => {
            if (v === null || v === undefined) return '<i class="is-null">NULL</i>';
            if (v instanceof Date) {
                let dateStr = v.toISOString().replace('T', ' ').substring(0, 19);
                if (dateStr.endsWith(' 00:00:00')) dateStr = dateStr.substring(0, 10);
                return dateStr;
            }
            if (typeof v === 'object') return JSON.stringify(v);
            return v;
        };

        // Render dữ liệu bảng
        const data = await AppState.adapters[engine].execute(db, `SELECT * FROM ${tableName} LIMIT 100`);
        const dContainer = document.getElementById('grid-data');
        dContainer.innerHTML = '';
        if(data.length > 0) {
            const dt = document.createElement('table'); dt.className = 'data-table';
            const h = `<thead><tr>${Object.keys(data[0]).map(k=>`<th>${k}</th>`).join('')}</tr></thead>`;
            
            // Áp dụng hàm formatVal vào dữ liệu
            const b = `<tbody>${data.map(r=>`<tr>${Object.values(r).map(v=>`<td>${formatVal(v)}</td>`).join('')}</tr>`).join('')}</tbody>`;
            
            dt.innerHTML = h + b; 
            dContainer.appendChild(dt);
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

    // --- CHIA SẺ TRUY VẤN (TẠO LINK) ---
    document.getElementById('btn-share-sql').onclick = () => {
        const sql = AppState.editors.b.getValue();
        if(!sql.trim()) return alert("Trình soạn thảo đang trống!");
        const base64Code = btoa(unescape(encodeURIComponent(sql)));
        const shareUrl = `${window.location.origin}${window.location.pathname}#code=${base64Code}`;
        
        navigator.clipboard.writeText(shareUrl).then(() => {
            logMessage("Đã copy Link chia sẻ SQL vào Clipboard!", "success");
            alert("Đã copy Link chia sẻ! Bạn có thể dán gửi cho bạn bè.");
        });
    };

    // --- EXCEL & GEOJSON EXPORT ---
    document.getElementById('btn-export-excel').onclick = () => {
        if(!AppState.gridData.length) return;
        const ws = XLSX.utils.json_to_sheet(AppState.gridData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Results");
        XLSX.writeFile(wb, "SQL_Results.xlsx");
    };

    document.getElementById('btn-export-geojson').onclick = () => {
        const features = AppState.gridData.map(row => {
            let geom = null;
            Object.values(row).forEach(val => {
                if (typeof val === 'string' && val.includes('"coordinates"')) try { geom = JSON.parse(val); } catch(e){}
                else if (typeof val === 'object' && val !== null && val.coordinates) geom = val;
            });
            if(!geom) return null;
            return { type: "Feature", geometry: geom, properties: row };
        }).filter(f => f !== null);

        if(features.length === 0) return alert("Không tìm thấy dữ liệu Không gian (GeoJSON) trong kết quả!");
        
        const geojson = { type: "FeatureCollection", features: features };
        downloadFile(JSON.stringify(geojson, null, 2), "spatial_data.geojson", "application/json");
    };

    // --- NHÓM TÍNH NĂNG ĐỘC QUYỀN: BẢN ĐỒ POSTGIS (SPATIAL VIEWER) ---
    const btnMap = document.getElementById('btn-load-map');
    if (btnMap) {
        btnMap.addEventListener('click', () => {
            // 1. Khởi tạo bản đồ nếu chưa có
            if (!mapInstance) {
                mapInstance = L.map('map-container').setView([16.047079, 108.206230], 6);
                
                // NÂNG CẤP: Dùng luôn Tile của Google Maps (Mượt, đẹp, không bị chặn khi chạy local)
                L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
                    attribution: '© Google Maps',
                    maxZoom: 19
                }).addTo(mapInstance);

                // CÚ CHỐT DIỆT LỖI TRẮNG BẢN ĐỒ: Tự động theo dõi và fix kích thước khi Tab mở
                const resizeObserver = new ResizeObserver(() => {
                    mapInstance.invalidateSize();
                });
                resizeObserver.observe(document.getElementById('map-container'));
            }

            // Đợi 1 chút để hiệu ứng chuyển tab hoàn tất rồi mới cắm cờ
            setTimeout(() => {
                // 2. Xóa các điểm/vùng dữ liệu cũ
                mapInstance.eachLayer(layer => {
                    if (layer.feature) mapInstance.removeLayer(layer);
                });

                let hasSpatialData = false;
                let bounds = L.latLngBounds();

                // 3. Quét kết quả truy vấn hiện tại
                AppState.gridData.forEach(row => {
                    Object.values(row).forEach(val => {
                        let geoObj = null;
                        if (typeof val === 'string' && val.includes('"coordinates"')) {
                            try { geoObj = JSON.parse(val); } catch(e) {}
                        } 
                        else if (typeof val === 'object' && val !== null && val.coordinates) {
                            geoObj = val;
                        }

                        // Nếu tìm thấy data -> Vẽ lên
                        if (geoObj && geoObj.type) {
                            hasSpatialData = true;
                            const layer = L.geoJSON(geoObj, {
                                onEachFeature: (feature, layer) => {
                                    const popupContent = Object.entries(row).map(([k, v]) => `<b>${k}:</b> ${v}`).join('<br>');
                                    layer.bindPopup(popupContent);
                                }
                            }).addTo(mapInstance);
                            bounds.extend(layer.getBounds());
                        }
                    });
                });

                // Tự động zoom vừa vặn
                if (hasSpatialData) {
                    mapInstance.fitBounds(bounds, { padding: [20, 20] });
                    logMessage("Đã render dữ liệu không gian lên Bản đồ!", "success");
                }
            }, 50); 
        });
    }
    // 1. TÍNH NĂNG ẨN/HIỆN SIDEBAR (Chính là cái bạn đang thiếu)
    // --- CHẾ ĐỘ XEM (SPLIT VIEW / FOCUS MODE) ---
    const paneA = document.getElementById('pane-a');
    const paneB = document.getElementById('pane-b');
    const resizerV = document.getElementById('resizer-v');
    const layoutBtns = document.querySelectorAll('.layout-toggles .icon-btn');

    const setLayout = (mode, btnId) => {
        layoutBtns.forEach(b => b.classList.remove('active'));
        document.getElementById(btnId).classList.add('active');

        if (mode === 'split') {
            paneA.style.display = 'flex'; paneA.style.flex = '0 0 50%';
            paneB.style.display = 'flex'; paneB.style.flex = '1';
            resizerV.style.display = 'block';
        } else if (mode === 'focus-a') {
            paneA.style.display = 'flex'; paneA.style.flex = '1';
            paneB.style.display = 'none';
            resizerV.style.display = 'none';
        } else if (mode === 'focus-b') {
            paneA.style.display = 'none';
            paneB.style.display = 'flex'; paneB.style.flex = '1';
            resizerV.style.display = 'none';
        }
        // Refresh lại CodeMirror để nó render full khung hình
        setTimeout(() => { AppState.editors.a.refresh(); AppState.editors.b.refresh(); }, 50);
    };

    document.getElementById('layout-split').onclick = () => setLayout('split', 'layout-split');
    document.getElementById('layout-focus-a').onclick = () => setLayout('focus-a', 'layout-focus-a');
    document.getElementById('layout-focus-b').onclick = () => setLayout('focus-b', 'layout-focus-b');

    // --- HỆ THỐNG PHÍM TẮT TOÀN CẦU (GLOBAL SHORTCUTS) ---
    document.addEventListener('keydown', (e) => {
        // Tránh bắt phím khi đang nhập liệu vào form (như ô Search, Create Table)
        if(e.target.tagName === 'INPUT') return; 

        // Ctrl + B: Toggle Sidebar
        if (e.ctrlKey && e.key.toLowerCase() === 'b') {
            e.preventDefault();
            document.getElementById('btn-toggle-sidebar').click();
        }
        
        // Ctrl + J: Toggle Bottom Panel (Khung kết quả)
        if (e.ctrlKey && e.key.toLowerCase() === 'j') {
            e.preventDefault();
            const bottomPanel = document.getElementById('bottom-panel');
            const resizerH = document.getElementById('resizer-h');
            if (bottomPanel.style.display === 'none') {
                bottomPanel.style.display = 'flex';
                resizerH.style.display = 'block';
            } else {
                bottomPanel.style.display = 'none';
                resizerH.style.display = 'none';
            }
        }

        // Ctrl + S: Tải mã SQL ở Editor B về máy (.sql)
        if (e.ctrlKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            const sqlContent = AppState.editors.b.getValue();
            if (sqlContent.trim()) {
                downloadFile(sqlContent, `query_${AppState.activeDBs[AppState.currentEngine]}.sql`, 'application/sql');
                logMessage("Đã lưu mã SQL thành file tải về", "success");
            } else {
                logMessage("Không có mã SQL nào để lưu", "warning");
            }
        }
    });

    // --- NHÓM 1: IMPORT CSV BẰNG PAPAPARSE ---
    document.getElementById('file-import-csv').onchange = (e) => {
        const file = e.target.files[0]; if(!file) return;
        const tableName = prompt("Nhập tên bảng sẽ Import CSV vào:", file.name.split('.')[0]);
        if(!tableName) return;
        
        Papa.parse(file, {
            header: true, skipEmptyLines: true,
            complete: async function(results) {
                const data = results.data;
                if(data.length === 0) return alert("File CSV trống!");
                
                logMessage(`Đang import ${data.length} dòng vào bảng ${tableName}...`, "info");
                const engine = AppState.currentEngine;
                const db = AppState.activeDBs[engine];
                
                try {
                    // Tạo bảng tự động dựa trên Header của CSV
                    const cols = Object.keys(data[0]).map(k => `${k} TEXT`).join(', ');
                    await AppState.adapters[engine].execute(db, `CREATE TABLE IF NOT EXISTS ${tableName} (${cols})`);
                    
                    // Tạo lệnh INSERT hàng loạt
                    for(let row of data) {
                        const keys = Object.keys(row).join(', ');
                        const vals = Object.values(row).map(v => `'${String(v).replace(/'/g, "''")}'`).join(', ');
                        await AppState.adapters[engine].execute(db, `INSERT INTO ${tableName} (${keys}) VALUES (${vals})`);
                    }
                    logMessage(`✅ Import CSV thành công!`, "success");
                    refreshExplorer();
                } catch(err) {
                    logMessage("Lỗi Import: " + err.message, "error");
                }
            }
        });
    };

   // --- NHÓM 3: VẼ SƠ ĐỒ ER DIAGRAM (Có liên kết & Zoom bằng chuột) ---
    document.getElementById('btn-load-er').addEventListener('click', async () => {
        const engine = AppState.currentEngine;
        const db = AppState.activeDBs[engine];
        const erContainer = document.getElementById('er-canvas');
        
        try {
            const tables = await AppState.adapters[engine].getTables(db);
            if (!tables || tables.length === 0) return erContainer.innerHTML = "Chưa có bảng nào để vẽ sơ đồ.";
            
            erContainer.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang vẽ sơ đồ...`;
            
            let erCode = "erDiagram\n";
            
            // 1. VẼ CÁC BẢNG VÀ CỘT
            for (let t of tables) {
                const schema = await AppState.adapters[engine].getTableSchema(db, t);
                let safeTable = String(t).replace(/[^a-zA-Z0-9_]/g, ''); 
                erCode += `    ${safeTable} {\n`;
                
                if (schema && schema.length > 0) {
                    schema.forEach(c => {
                        let typeClean = String(c.data_type || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_'); 
                        let colClean = String(c.column_name || 'col').replace(/[^a-zA-Z0-9_]/g, '');
                        let pkAttr = c.is_pk == 1 ? 'PK' : '';
                        erCode += `        ${typeClean} ${colClean} ${pkAttr}\n`;
                    });
                } else {
                    erCode += `        unknown no_column\n`;
                }
                erCode += `    }\n`;
            }
            
            // 2. VẼ DÂY LIÊN KẾT (RELATIONSHIPS)
            const fks = await AppState.adapters[engine].getForeignKeys(db);
            fks.forEach(fk => {
                let from = String(fk.from_table).replace(/[^a-zA-Z0-9_]/g, '');
                let to = String(fk.to_table).replace(/[^a-zA-Z0-9_]/g, '');
                // Vẽ quan hệ 1-nhiều (1 to_table có nhiều from_table)
                erCode += `    ${to} ||--o{ ${from} : "liên_kết"\n`;
            });

            mermaid.initialize({ startOnLoad: false, theme: 'default' });
            
            const renderId = 'mermaid-svg-' + Math.random().toString(36).substr(2, 9);
            const { svg } = await mermaid.render(renderId, erCode);
            erContainer.innerHTML = svg;

            // 3. FIX LỖI HIỂN THỊ VÀ KÍCH HOẠT TÍNH NĂNG ZOOM/PAN
            // Ép khung chứa phải căng cứng 100% để SVG không bị bóp méo
            erContainer.style.width = '100%';
            erContainer.style.height = '100%';
            erContainer.style.display = 'flex';
            erContainer.style.justifyContent = 'center';
            erContainer.style.alignItems = 'center';
            erContainer.style.overflow = 'hidden';

            const svgElement = erContainer.querySelector('svg');
            
            if (svgElement && typeof svgPanZoom !== 'undefined') {
                // Đảm bảo SVG bung full khung
                svgElement.style.width = '100%';
                svgElement.style.height = '100%';
                svgElement.style.maxWidth = 'none';
                
                // MẤU CHỐT LÀ ĐÂY: Trì hoãn 100ms để trình duyệt kịp tính toán layout thật
                setTimeout(() => {
                    const panZoomInstance = svgPanZoom(svgElement, {
                        zoomEnabled: true,
                        controlIconsEnabled: true,
                        fit: true,       // Ép SVG vừa khít màn hình
                        center: true,    // Đưa ra giữa
                        minZoom: 0.1,    // Cho phép thu nhỏ tẹt ga (để nhìn thấy các bảng xa nhau)
                        maxZoom: 10
                    });
                    
                    // Gọi lại hàm update để đảm bảo nó căn lại một lần nữa cho chắc cốp
                    panZoomInstance.resize();
                    panZoomInstance.fit();
                    panZoomInstance.center();
                    
                }, 100);
            }

        } catch (err) {
            console.error("Lỗi vẽ Mermaid:", err);
            erContainer.innerHTML = `<div style="color:var(--danger); padding:10px;"><b>Lỗi:</b> ${err.message}</div>`;
        }
    });

    // --- NHÓM 4: EXPLAIN QUERY ---
    document.getElementById('btn-explain-query').onclick = () => {
        let sql = AppState.editors.b.somethingSelected() ? AppState.editors.b.getSelection() : AppState.editors.b.getValue();
        if(!sql.trim()) return logMessage("Không có SQL để phân tích", "error");
        
        if(!sql.trim().toUpperCase().startsWith('EXPLAIN')) {
            AppState.editors.b.setValue(`EXPLAIN ${sql}`);
        }
        runQuery('b');
    };

    // --- NHÓM 4: COMMAND PALETTE (CTRL + SHIFT + P) ---
    const cmdModal = document.getElementById('modal-cmd');
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'p') {
            e.preventDefault();
            cmdModal.classList.add('active');
            document.getElementById('cmd-input').focus();
        }
    });
    
    // Xử lý click vào các lệnh trong Command Palette
    document.querySelectorAll('#cmd-list li').forEach(li => {
        li.onclick = () => {
            const action = li.getAttribute('data-action');
            if (action === 'format') document.getElementById('btn-format-sql').click();
            if (action === 'theme') document.getElementById('btn-theme-toggle').click();
            
            if (action === 'backup') document.getElementById('btn-backup').click();
            if (action === 'clear') document.getElementById('log-messages').innerHTML = 'Đã xóa nhật ký.';
            cmdModal.classList.remove('active');
        };
    });
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
    document.getElementById('btn-new-db').onclick = async () => {
    let name = prompt(`Nhập tên Database mới cho ${AppState.currentEngine.toUpperCase()}:`);
    if (name) {
        name = name.trim().toLowerCase();
        
        // Validate bằng Regex hệt như code cũ
        if (/^[a-z0-9_]+$/.test(name)) {
            if (AppState.dbLists[AppState.currentEngine].includes(name)) {
                return alert("Database đã tồn tại trong Engine này!");
            }
            
            // 1. BẬT BỨC MÀN LOADING LÊN TRƯỚC
            if (window.showLoader) showLoader(`Đang khởi tạo Database ${name}\n    Vui lòng chờ trong giây lát!`);
            
            // Ép trình duyệt ngưng 50ms để kịp vẽ cái màn hình Loading ra
            await new Promise(resolve => setTimeout(resolve, 50));
            
            try {
                // 2. CHẠY TÁC VỤ NẶNG (Cập nhật state, tạo DB, vẽ lại UI)
                AppState.dbLists[AppState.currentEngine].push(name);
                AppState.activeDBs[AppState.currentEngine] = name;
                
                // Lưu trạng thái
                localStorage.setItem('ide_db_lists', JSON.stringify(AppState.dbLists));
                localStorage.setItem('ide_active_dbs', JSON.stringify(AppState.activeDBs));
                
                // Khởi tạo và báo thành công
                await AppState.adapters[AppState.currentEngine].createDB(name);
                await refreshExplorer();
                logMessage(`Đã tạo Database: ${name}`, "success");
            } catch (err) {
                alert("Lỗi khi tạo Database: " + err.message);
                logMessage("Lỗi tạo DB: " + err.message, "error");
            } finally {
                // 3. TẮT MÀN HÌNH LOADING DÙ THÀNH CÔNG HAY THẤT BẠI
                if (window.hideLoader) hideLoader();
            }
            
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
        btn.addEventListener('click', (e) => switchTab(e.currentTarget.dataset.target));
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

// ==========================================
// TỰ ĐỘNG BẬT LOADING KHI VỪA KHỞI ĐỘNG WEB
// ==========================================
window.onload = async () => {
    // 1. Bật màn hình loading che kín giao diện ngay lập tức
    window.showLoader("Đang khởi tạo SQL Studio \n     Vui lòng chờ trong giây lát!");
    
    // Cho trình duyệt thở 50ms để kịp render giao diện màn hình mờ
    await new Promise(resolve => setTimeout(resolve, 50));
    
    try {
        // 2. Chạy hàm khởi tạo nặng phía trên
        await initSystem();
    } catch (err) {
        console.error("Lỗi khởi động hệ thống:", err);
        alert("Lỗi khởi động: " + err.message);
    } finally {
        // 3. Tắt màn hình loading khi mọi thứ đã sẵn sàng
        window.hideLoader();
    }
};
window.genSQL = async (tableName, type) => {
    const engine = AppState.currentEngine;
    const db = AppState.activeDBs[engine];
    const schema = await AppState.adapters[engine].getTableSchema(db, tableName);
    const cols = schema.map(c => c.column_name);
    
    let sql = '';
    if(type === 'SELECT') sql = `SELECT ${cols.join(', ')}\nFROM ${tableName}\nLIMIT 100;`;
    if(type === 'INSERT') sql = `INSERT INTO ${tableName} (${cols.join(', ')})\nVALUES (${cols.map(()=>"'?'").join(', ')});`;
    
    AppState.editors.b.setValue(sql);
    logMessage(`Đã sinh mã ${type} cho bảng ${tableName}`, "info");
};

window.applyTheme = function(themeName) {
    // 1. Phân loại xem theme này là nền Trắng hay nền Đen để đổi màu tổng thể của web
    const lightThemes = ['default', 'eclipse'];
    if (lightThemes.includes(themeName)) {
        document.body.setAttribute('data-theme', 'light');
    } else {
        document.body.removeAttribute('data-theme');
    }
    
    // 2. Ép CodeMirror đổi màu ngay lập tức
    if (AppState.editors && AppState.editors.a) {
        AppState.editors.a.setOption('theme', themeName);
        AppState.editors.b.setOption('theme', themeName);
    }
    
    // 3. Lưu vào bộ nhớ để F5 không bị mất
    localStorage.setItem('ide_theme', themeName);
};

// ==========================================
// MÀN HÌNH LOADING CHE TOÀN TRANG
// ==========================================
window.showLoader = function(message = "Đang xử lý...") {
    let loader = document.getElementById('global-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'global-loader';
        loader.innerHTML = `
            <div class="loader-box">
                <div class="spinner"></div>
                <img src="2.png" alt="Logo" class="loader-logo">
            </div>
            <div class="loader-text" id="loader-text"></div>
            <style>
                #global-loader {
                    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                    background: rgba(0, 0, 0, 0.75); z-index: 99999;
                    display: flex; flex-direction: column; justify-content: center; align-items: center;
                    color: #fff; font-family: sans-serif; font-size: 16px;
                    backdrop-filter: blur(4px);
                }
                .loader-box {
                    position: relative; width: 80px; height: 80px;
                    display: flex; justify-content: center; align-items: center;
                    margin-bottom: 20px;
                }
                .spinner {
                    position: absolute; top: 0; left: 0; width: 80px; height: 80px;
                    border: 5px solid rgba(255, 255, 255, 0.2);
                    border-top-color: #ff9800; border-radius: 50%;
                    animation: spin 1s linear infinite;
                }
                .loader-logo {
                    width: 40px; height: 40px; object-fit: contain;
                    border-radius: 50%; animation: pulse 1.5s ease-in-out infinite;
                }
                @keyframes spin { 100% { transform: rotate(360deg); } }
                @keyframes pulse { 0%, 100% { transform: scale(0.9); opacity: 0.8; } 50% { transform: scale(1.1); opacity: 1; } }
            </style>
        `;
        document.body.appendChild(loader);
    }
    document.getElementById('loader-text').innerText = message;
    loader.style.display = 'flex';
};

window.hideLoader = function() {
    const loader = document.getElementById('global-loader');
    if (loader) loader.style.display = 'none';
};
// --- BẮT BUỘC EDITOR VẼ LẠI CHỮ KHI THAY ĐỔI KÍCH THƯỚC MÀN HÌNH ---
window.addEventListener('resize', () => {
    // Độ trễ 50ms để trình duyệt kịp tính toán xong khung Flexbox
    setTimeout(() => {
        if (AppState.editors && AppState.editors.a) AppState.editors.a.refresh();
        if (AppState.editors && AppState.editors.b) AppState.editors.b.refresh();
    }, 50);
});