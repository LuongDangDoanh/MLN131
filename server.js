const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
let aiClientCache = new Map();
require('dotenv').config();

/*
 * This Node.js server implements the religion game described by the user.
 * It uses minimal dependencies (only built‑in modules and uuid for session IDs).
 * Sessions are stored in memory keyed by a cookie. The scoreboard is persisted
 * to a JSON file on disk. All pages are rendered via simple string templates
 * inside this file for clarity and to avoid external dependencies.
 */

// Data directory and scoreboard file path
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
const SCOREBOARD_FILE = path.join(DATA_DIR, 'scoreboard.json');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// Load scoreboard from file
function loadScoreboard() {
    try {
        const data = fs.readFileSync(SCOREBOARD_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
}

// Save scoreboard to file
function saveScoreboard(list) {
    fs.writeFileSync(SCOREBOARD_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

// Predefined religions
const PREDEFINED_RELIGIONS = [
    'Phật giáo',
    'Đạo giáo',
    'Công giáo',
    'Tin lành',
    'Hồi giáo'
];

// State regulations text
const STATE_REGULATIONS = {
    policy: [
        'Thực hiện nhất quán chính sách tôn trọng và bảo đảm quyền tự do tín ngưỡng.',
        'Quyền sinh hoạt tôn giáo bình thường theo đúng pháp luật.',
        'Nghiêm cấm mọi hành vi chia rẽ, phân biệt đối xử vì lý do tôn giáo.',
        "Mục tiêu chung: 'Dân giàu, nước mạnh, dân chủ, công bằng, văn minh'."
    ],
    prohibited: [
        'Lợi dụng tôn giáo để hoạt động mê tín dị đoan.',
        'Làm trái pháp luật, kích động chia rẽ nhân dân, chia rẽ dân tộc.',
        'Xâm phạm an ninh quốc gia.',
        "Lợi dụng tôn giáo để chống phá, can thiệp nội bộ (âm mưu 'diễn biến hòa bình').",
        'Ép buộc người dân theo đạo hoặc truyền đạo trái phép.'
    ]
};

// Keywords that violate regulations
const VIOLATION_KEYWORDS = [
    'chia rẽ', 'kích động', 'xâm phạm', 'chống phá', 'ép buộc',
    'trái phép', 'mê tín', 'diễn biến hoà bình', 'bạo lực'
];

// Positive and negative keywords for evaluation heuristic
const POSITIVE_KEYWORDS = [
    'hoà bình', 'đoàn kết', 'từ thiện', 'giáo dục', 'phát triển',
    'hỗ trợ', 'tôn trọng', 'khuyến khích', 'công bằng'
];
const NEGATIVE_KEYWORDS = [
    'bạo lực', 'chiến tranh', 'phân biệt', 'áp bức', 'mê tín'
];

// Suggested policies for predefined religions
const SUGGESTED_POLICIES = [
    'Xây dựng trường học và bệnh viện để phục vụ tín đồ.',
    'Tổ chức hoạt động từ thiện hỗ trợ người nghèo.',
    'Khuyến khích tín đồ tham gia sản xuất và phát triển kinh tế.',
    'Thực hiện các buổi lễ cầu nguyện vì hoà bình và đoàn kết.',
    'Hỗ trợ giáo dục đạo đức và học tập cho trẻ em trong cộng đồng.'
];

// Sessions stored in memory: { sessionId: { username, game: {...} } }
const sessions = {};

// Generate simple HTTP response
function sendResponse(res, statusCode, contentType, body) {
    res.writeHead(statusCode, { 'Content-Type': contentType });
    res.end(body);
}

// Basic HTML escape to avoid accidental injection when rendering feedback
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Parse cookies from request headers
function parseCookies(req) {
    const list = {};
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(function(cookie) {
        const parts = cookie.split('=');
        const key = parts.shift().trim();
        const value = decodeURIComponent(parts.join('='));
        list[key] = value;
    });
    return list;
}

// Generate a pseudo‑random session ID and set cookie
function createSession(res, userInfo) {
    const user = typeof userInfo === 'string' ? { name: userInfo } : (userInfo || {});
    const displayName = user.name || user.email || 'Nguoi choi';
    // Simple random ID using current timestamp and random number
    const id = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    sessions[id] = { username: displayName, user, game: null };
    res.setHeader('Set-Cookie', `sessionId=${id}; HttpOnly; Path=/`);
    return id;
}

function clamp(num, min, max) {
    return Math.min(max, Math.max(min, num));
}

// Build prompt for Gemini
function buildGeminiPrompt(decision, context) {
    const regulationsText = [
        'Chính sách: ' + STATE_REGULATIONS.policy.join(' | '),
        'Nghiêm cấm: ' + STATE_REGULATIONS.prohibited.join(' | ')
    ].join('\n');
    return [
        'Bạn là một bậc hiền triết tôn giáo và chuyên gia đánh giá chính sách.',
        'Bối cảnh: tôn giáo hoạt động trong thời kỳ quá độ lên chủ nghĩa xã hội; phải khả thi, hòa bình, tôn trọng luật và quy định Nhà nước.',
        'Nhiệm vụ: đọc chính sách người chơi đưa ra, đánh giá tính khả thi, tác động tới số tín đồ, và đưa nhận xét ngắn gọn.',
        'Đặc biệt: nếu chính sách vi phạm quy định Nhà nước, kích động bạo lực, hoặc chia rẽ, hãy đặt change = -10000 và comment = "Bạn đã vi phạm các quy định của Nhà nước, tôn giáo của bạn sẽ bị xóa bỏ."',
        'Thông tin tôn giáo:',
        `- Tên tôn giáo: ${context.religion}`,
        `- Vòng: ${context.round}`,
        `- Số tín đồ hiện tại: ${context.followers}`,
        'Quy định Nhà nước:',
        regulationsText,
        'Chính sách người chơi đề xuất:',
        decision,
        'Định dạng trả về (JSON duy nhất, không giải thích thêm):',
        '{"change": number (âm hoặc dương), "comment": "nhận xét ngắn gọn", "tips": ["gợi ý1","gợi ý2"]}',
        'Giới hạn: change trong khoảng -400 đến 400 nếu hợp lệ; dùng -10000 khi vi phạm.'
    ].join('\n');
}

// Call Gemini model
function getApiKeys() {
    const listEnv = process.env.GEMINI_API_KEYS || '';
    const list = listEnv.split(',').map(k => k.trim()).filter(Boolean);
    const singles = [process.env.GEMINI_API_KEY, process.env.API_KEY, process.env.GOOGLE_API_KEY].filter(Boolean);
    const combined = [...list, ...singles].filter(Boolean).slice(0, 6);
    if (combined.length === 0) {
        throw new Error('API_KEY / GOOGLE_API_KEY / GEMINI_API_KEY / GEMINI_API_KEYS is not set');
    }
    return combined;
}

async function getClientForKey(apiKey) {
    if (aiClientCache.has(apiKey)) return aiClientCache.get(apiKey);
    let GoogleGenAI;
    try {
        ({ GoogleGenAI } = require('@google/genai'));
    } catch (err) {
        // fallback dynamic import for ESM-only environments
        const mod = await import('@google/genai');
        GoogleGenAI = mod.GoogleGenAI || (mod.default && mod.default.GoogleGenAI);
        if (!GoogleGenAI) {
            throw new Error('Missing dependency @google/genai. Run: npm install @google/genai');
        }
    }
    const client = new GoogleGenAI({ apiKey });
    aiClientCache.set(apiKey, client);
    return client;
}

async function callGemini(decision, context) {
    const prompt = buildGeminiPrompt(decision, context);
    const apiKeys = getApiKeys();
    let lastError = null;
    for (const key of apiKeys) {
        try {
            const client = await getClientForKey(key);
            const result = await client.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: prompt
            });
            return result;
        } catch (err) {
            lastError = err;
            console.error(`Gemini error with key ending ${key.slice(-4)}:`, err.message || err);
            // try next key
        }
    }
    throw lastError || new Error('Gemini call failed for all configured API keys.');
}

function parseGeminiResult(resp) {
    let text = '';
    if (resp && resp.response && typeof resp.response.text === 'function') {
        text = resp.response.text();
    } else if (resp && resp.candidates && resp.candidates[0] && resp.candidates[0].content && resp.candidates[0].content.parts) {
        const parts = resp.candidates[0].content.parts;
        text = parts.map(p => p.text || '').join(' ').trim();
    } else if (typeof resp === 'string') {
        text = resp;
    }
    text = (text || '').trim();
    if (!text) throw new Error('Empty response from Gemini');
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : text;
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (err) {
        throw new Error('Gemini response not in JSON format');
    }
    const change = typeof parsed.change === 'number' ? parsed.change : 0;
    const comment = parsed.comment || '';
    const tips = Array.isArray(parsed.tips) ? parsed.tips : [];
    return { change, comment, tips };
}

// Fallback heuristic if Gemini unavailable
function localHeuristic(decision) {
    const lower = decision.toLowerCase();
    for (const kw of VIOLATION_KEYWORDS) {
        if (lower.includes(kw)) {
            return { violation: true, change: -10000, comment: 'Bạn đã vi phạm các quy định của Nhà nước, tôn giáo của bạn sẽ bị xóa bỏ.', tips: [] };
        }
    }
    let score = 0;
    POSITIVE_KEYWORDS.forEach(pk => { if (lower.includes(pk)) score += 1; });
    NEGATIVE_KEYWORDS.forEach(nk => { if (lower.includes(nk)) score -= 1; });
    const randomFactor = Math.floor(Math.random() * 7) - 2; // -2 to +4
    let change = (score * 50) + (randomFactor * 20);
    change = clamp(change, -150, 300);
    return { violation: false, change, comment: 'Đánh giá nhanh (heuristic).', tips: [] };
}

// Evaluate decision via Gemini; returns { violation, change, comment, tips }
async function evaluateDecision(decision, context) {
    const lower = decision.toLowerCase();
    for (const kw of VIOLATION_KEYWORDS) {
        if (lower.includes(kw)) {
            return { violation: true, change: -10000, comment: 'Bạn đã vi phạm các quy định của Nhà nước, tôn giáo của bạn sẽ bị xóa bỏ.', tips: [] };
        }
    }
    try {
        const geminiResp = await callGemini(decision, context);
        const parsed = parseGeminiResult(geminiResp);
        if (parsed.change <= -10000) {
            return { violation: true, change: -10000, comment: parsed.comment || 'Bạn đã vi phạm các quy định của Nhà nước, tôn giáo của bạn sẽ bị xóa bỏ.', tips: parsed.tips || [] };
        }
        return {
            violation: false,
            change: clamp(parsed.change, -400, 400),
            comment: parsed.comment || '',
            tips: parsed.tips || []
        };
    } catch (err) {
        console.error('Gemini scoring failed, using heuristic:', err.message || err);
        return localHeuristic(decision);
    }
}

// Verify Google ID token using Google's tokeninfo endpoint
function verifyGoogleIdToken(idToken) {
    return new Promise((resolve, reject) => {
        if (!GOOGLE_CLIENT_ID) {
            return reject(new Error('Google Sign-In is not configured (missing GOOGLE_CLIENT_ID).'));
        }
        if (!idToken) {
            return reject(new Error('Missing Google credential.'));
        }
        const tokenInfoUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
        https.get(tokenInfoUrl, (resp) => {
            let data = '';
            resp.on('data', chunk => { data += chunk; });
            resp.on('end', () => {
                if (resp.statusCode !== 200) {
                    return reject(new Error('Google token validation failed.'));
                }
                try {
                    const payload = JSON.parse(data);
                    if (payload.aud !== GOOGLE_CLIENT_ID) {
                        return reject(new Error('Token audience does not match configured client id.'));
                    }
                    const now = Math.floor(Date.now() / 1000);
                    if (payload.exp && now > Number(payload.exp)) {
                        return reject(new Error('Google token expired.'));
                    }
                    resolve(payload);
                } catch (err) {
                    reject(new Error('Invalid token response from Google.'));
                }
            });
        }).on('error', (err) => reject(err));
    });
}

// Build HTML for regulations (used in game page)
function buildRegulationsHTML() {
    let html = '<details class="regulations"><summary>📖 Quy định của Nhà nước</summary>';
    html += '<h3>Chính sách</h3><ul>';
    STATE_REGULATIONS.policy.forEach(rule => { html += `<li>${rule}</li>`; });
    html += '</ul><h3>Nghiêm cấm</h3><ul>';
    STATE_REGULATIONS.prohibited.forEach(rule => { html += `<li>${rule}</li>`; });
    html += '</ul><p><em>Lưu ý: Nếu lựa chọn của bạn vi phạm những quy định này, trò chơi sẽ kết thúc và điểm bằng 0.</em></p>';
    html += '</details>';
    return html;
}

// Render HTML for pages
function renderPage(title, bodyContent, username) {
    // Basic layout shared across pages
    let nav = '';
    if (username) {
        nav = `<nav>Xin chào, ${username}! | <a href="/">Trang chủ</a> | <a href="/start">Bắt đầu trò chơi</a> | <a href="/leaderboard">Bảng xếp hạng</a> | <a href="/logout">Đăng xuất</a></nav>`;
    }
    return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><link rel="stylesheet" href="/static/style.css"></head><body><header><h1><a href="/">Trò chơi Tôn giáo trong Thời kỳ Quá độ</a></h1>${nav}</header><main>${bodyContent}</main><footer><p>&copy; 2026 Trò chơi Tôn giáo. Tất cả các nội dung mang tính giáo dục và mô phỏng.</p></footer></body></html>`;
}

// Server handler
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const cookies = parseCookies(req);
    const sessionId = cookies.sessionId;
    const session = sessionId && sessions[sessionId] ? sessions[sessionId] : null;
    const username = session ? session.username : null;

    // Serve static files
    if (pathname.startsWith('/static/')) {
        const filePath = path.join(__dirname, pathname);
        fs.readFile(filePath, (err, data) => {
            if (err) {
                sendResponse(res, 404, 'text/plain', 'Not Found');
            } else {
                let contentType = 'text/plain';
                if (filePath.endsWith('.css')) contentType = 'text/css';
                sendResponse(res, 200, contentType, data);
            }
        });
        return;
    }

    // Home page
    if (pathname === '/') {
        if (!username) {
            // Redirect to login
            res.writeHead(302, { Location: '/login' });
            res.end();
            return;
        }
        const body = `<section class="hero">
    <div class="hero__glow"></div>
    <div class="hero__content card-3d">
        <p class="eyebrow">Hành trình tôn giáo</p>
        <h2>Trò chơi tôn giáo trong thời kỳ giả tưởng</h2>
        <p class="lede">Đồng hành cùng giáo phái của bạn, đưa ra chính sách khôn ngoan và dẫn dắt tôn giáo vượt qua thách thức.</p>
        <div class="cta-buttons">
            <a class="button primary" href="/start">Bắt đầu ngay</a>
            <a class="button ghost" href="/leaderboard">Bảng xếp hạng</a>
        </div>
    </div>
    <div class="hero__deck">
        <div class="info-card card-3d">
            <p class="eyebrow">Chế độ</p>
            <h3>10 vòng quyết định</h3>
            <p>Mỗi lựa chọn sẽ thay đổi số người theo đạo và số phận tôn giáo của bạn.</p>
        </div>
        <div class="info-card card-3d">
            <p class="eyebrow">Thử thách</p>
            <h3>Tự do & Quy tắc</h3>
            <p>Tự tạo giáo phái hoặc chọn có sẵn, nhưng phải luôn tuân thủ quy định nhà nước.</p>
        </div>
        <div class="info-card card-3d">
            <p class="eyebrow">Mục tiêu</p>
            <h3>Mở rộng tín đồ</h3>
            <p>Đạt 1.000+ tín đồ để ghi tên lên bảng xếp hạng và trở thành người sáng lập.</p>
        </div>
    </div>
</section>`;
        sendResponse(res, 200, 'text/html', renderPage('Trang chủ', body, username));
        return;
    }

    // Login page
    if (pathname === '/login' && req.method === 'GET') {
        if (username) {
            res.writeHead(302, { Location: '/' });
            res.end();
            return;
        }
        let body = '';
        if (!GOOGLE_CLIENT_ID) {
            body = `<section class="login-hero full-width">
    <div class="login-card card-3d">
        <p class="eyebrow">Chưa cấu hình</p>
        <h2>Đăng nhập bằng Google</h2>
        <p>Chưa cấu hình GOOGLE_CLIENT_ID. Tạo OAuth client ID (Web) trên Google Cloud, thêm nguồn gốc http://localhost:7860 rồi đặt biến môi trường GOOGLE_CLIENT_ID trước khi chạy server.</p>
        <p>Tạm thời bạn có thể dùng đăng nhập tạm để kiểm thử.</p>
        <form method="post" action="/login" class="fallback-login-form">
            <label for="username">Tên hiển thị tạm:</label>
            <input type="text" id="username" name="username" required>
            <button type="submit" class="button primary">Đăng nhập tạm</button>
        </form>
    </div>
</section>`;
        } else {
            body = `<section class="login-hero full-width">
    <div class="login-card card-3d">
        <p class="eyebrow">Chào mừng</p>
        <h2>Đăng nhập bằng Google</h2>
        <p class="lede">Nhấn nút Google để bắt đầu. Chúng tôi chỉ dùng tên và email để lưu điểm trên bảng xếp hạng.</p>
        <div id="g_id_signin"></div>
        <div id="login-error" class="login-error" aria-live="polite"></div>
    </div>
</section>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<script>
const clientId='${GOOGLE_CLIENT_ID}';
function handleCredentialResponse(response){
    fetch('/login/google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:response.credential})})
        .then(r=>{if(r.ok){window.location.href='/';return;}return r.text().then(text=>{throw new Error(text||'Đăng nhập thất bại');});})
        .catch(err=>{const errBox=document.getElementById('login-error');if(errBox){errBox.textContent=err.message||'Đăng nhập thất bại';}});
}
window.onload=function(){
    google.accounts.id.initialize({client_id:clientId,callback:handleCredentialResponse});
    google.accounts.id.renderButton(document.getElementById('g_id_signin'),{theme:'outline',size:'large',width:360});
};
</script>`;
        }
        sendResponse(res, 200, 'text/html', renderPage('Đăng nhập', body, null));
        return;
    }
    if (pathname === '/login' && req.method === 'POST') {
        // Handle fallback login (only when Google Sign-In is not configured)
        if (GOOGLE_CLIENT_ID) {
            sendResponse(res, 400, 'text/plain', 'Vui long dang nhap bang Google.');
            return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const form = querystring.parse(body);
            const name = (form.username || '').trim();
            if (!name) {
                const content = '<p>Vui long nhap ten hien thi.</p><a href="/login">Quay lai</a>';
                sendResponse(res, 400, 'text/html', renderPage('Loi', content, null));
                return;
            }
            createSession(res, name);
            res.writeHead(302, { Location: '/' });
            res.end();
        });
        return;
    }
    if (pathname === '/login/google' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const parsed = body ? JSON.parse(body) : {};
                const credential = parsed.credential;
                const tokenPayload = await verifyGoogleIdToken(credential);
                createSession(res, {
                    name: tokenPayload.name,
                    email: tokenPayload.email,
                    picture: tokenPayload.picture,
                    sub: tokenPayload.sub
                });
                sendResponse(res, 200, 'application/json', JSON.stringify({ success: true }));
            } catch (err) {
                console.error('Google login error:', err.message || err);
                const httpStatus = (err && err.message && err.message.includes('configured')) ? 500 : 401;
                sendResponse(res, httpStatus, 'text/plain', (err && err.message) ? err.message : 'Google authentication failed');
            }
        });
        return;
    }
    // Logout
    if (pathname === '/logout') {
        if (sessionId) {
            delete sessions[sessionId];
            res.setHeader('Set-Cookie', 'sessionId=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        }
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
    }

    // Start page
    if (pathname === '/start' && req.method === 'GET') {
        if (!username) {
            res.writeHead(302, { Location: '/login' });
            res.end();
            return;
        }
        let religionOptions = '';
        PREDEFINED_RELIGIONS.forEach((r, idx) => {
            religionOptions += `<div><input type="radio" id="rel${idx}" name="religion_choice" value="${r}" required><label for="rel${idx}">${r}</label></div>`;
        });
        religionOptions += '<div><input type="radio" id="custom" name="religion_choice" value="custom" required><label for="custom">Tạo tôn giáo mới</label></div>';
        const body = `<h2>Chọn tôn giáo để bắt đầu</h2><form method="post" action="/start"><p>Hãy chọn một trong những tôn giáo có sẵn hoặc tự tạo tôn giáo của bạn:</p><div class="religion-list">${religionOptions}</div><button type="submit">Tiếp tục</button></form>`;
        sendResponse(res, 200, 'text/html', renderPage('Chọn tôn giáo', body, username));
        return;
    }
    if (pathname === '/start' && req.method === 'POST') {
        if (!username) {
            res.writeHead(302, { Location: '/login' });
            res.end();
            return;
        }
        let bodyData = '';
        req.on('data', chunk => { bodyData += chunk; });
        req.on('end', () => {
            const form = querystring.parse(bodyData);
            const choice = form.religion_choice;
            if (!choice) {
                res.writeHead(302, { Location: '/start' });
                res.end();
                return;
            }
            if (choice === 'custom') {
                res.writeHead(302, { Location: '/create' });
                res.end();
                return;
            }
            // Start game with predefined religion
            sessions[sessionId].game = {
                religion: choice,
                followers: 100,
                round: 1,
                history: []
            };
            res.writeHead(302, { Location: '/game' });
            res.end();
        });
        return;
    }

    // Create new religion
    if (pathname === '/create' && req.method === 'GET') {
        if (!username) {
            res.writeHead(302, { Location: '/login' });
            res.end();
            return;
        }
        const body = '<h2>Tạo tôn giáo của bạn</h2><p>Hãy đặt tên cho tôn giáo của bạn. Bạn sẽ có 100 người theo đạo ban đầu. Trong mỗi vòng, bạn cần đưa ra luật lệ và sự kiện mà không có gợi ý sẵn.</p><form method="post" action="/create"><label for="religion_name">Tên tôn giáo:</label><input type="text" id="religion_name" name="religion_name" required><button type="submit">Bắt đầu</button></form>';
        sendResponse(res, 200, 'text/html', renderPage('Tạo tôn giáo mới', body, username));
        return;
    }
    if (pathname === '/create' && req.method === 'POST') {
        if (!username) {
            res.writeHead(302, { Location: '/login' });
            res.end();
            return;
        }
        let bodyData = '';
        req.on('data', chunk => { bodyData += chunk; });
        req.on('end', () => {
            const form = querystring.parse(bodyData);
            const relName = (form.religion_name || '').trim();
            if (!relName) {
                res.writeHead(302, { Location: '/create' });
                res.end();
                return;
            }
            sessions[sessionId].game = {
                religion: relName,
                followers: 100,
                round: 1,
                history: []
            };
            res.writeHead(302, { Location: '/game' });
            res.end();
        });
        return;
    }

    // Game page
    if (pathname === '/game') {
        if (!username || !session || !session.game) {
            res.writeHead(302, { Location: '/' });
            res.end();
            return;
        }
        if (req.method === 'GET') {
            const game = session.game;
            // If round > 10, redirect to end
            if (game.round > 10) {
                res.writeHead(302, { Location: '/end' });
                res.end();
                return;
            }
            const roundNumber = game.round;
            const followers = game.followers;
            const religion = game.religion;
            let suggestionsHtml = '';
            if (PREDEFINED_RELIGIONS.includes(religion)) {
                suggestionsHtml += '<div class="suggestion-chips"><p class="eyebrow">Gợi ý chính sách</p>';
                SUGGESTED_POLICIES.forEach((suggestion) => {
                    suggestionsHtml += `<button type="button" class="suggestion-chip" onclick="document.getElementById('decision').value='${suggestion}'">${suggestion}</button>`;
                });
                suggestionsHtml += '</div>';
            }
            const regulationsHtml = buildRegulationsHTML();
            let feedbackHtml = '';
            if (game.lastFeedback) {
                const fb = game.lastFeedback;
                const tips = Array.isArray(fb.tips) ? fb.tips.map(t => `<li>${escapeHtml(t)}</li>`).join('') : '';
                const tipsHtml = tips ? `<ul class="tips-list">${tips}</ul>` : '';
                const changeLabel = fb.change >= 0 ? `+${fb.change}` : `${fb.change}`;
                feedbackHtml = `<div class="panel card-3d feedback-card">
                    <p class="eyebrow">Đánh giá từ hiền triết</p>
                    <p class="lede"><strong>Kết quả tín đồ:</strong> ${changeLabel}</p>
                    <p>${escapeHtml(fb.comment || 'Không có nhận xét')}</p>
                    ${tipsHtml}
                </div>`;
            }
            const body = `<section class="game-shell">
    <div class="panel card-3d">
        <p class="eyebrow">Tôn giáo</p>
        <h2>${religion}</h2>
        <div class="stat-row">
            <span class="pill">Người theo: ${followers}</span>
            <span class="pill">Vòng ${roundNumber} / 10</span>
        </div>
    </div>
    <div class="panel card-3d regulations-card">${regulationsHtml}</div>
    <div class="panel card-3d play-card">
        <div class="panel-header">
            <div>
                <p class="eyebrow">Quyết định</p>
                <h3>Chính sách vòng ${roundNumber}</h3>
            </div>
            <span class="pill pill-ghost">Viết ý tưởng của bạn</span>
        </div>
        ${suggestionsHtml}
        <form method="post" action="/game" class="decision-form">
            <label for="decision">Nhập chính sách / sự kiện:</label>
            <textarea id="decision" name="decision" rows="4" cols="60" placeholder="Nhập quyết định của bạn..." required></textarea>
            <div class="form-actions">
                <button type="submit" class="button primary">Gửi quyết định</button>
            </div>
        </form>
    </div>
</section>
${feedbackHtml}
<script>document.addEventListener('DOMContentLoaded', function(){const buttons=document.querySelectorAll('.suggestion-chip');buttons.forEach(function(btn){btn.addEventListener('click', function(){document.getElementById('decision').value=this.textContent;});});});</script>`;
            sendResponse(res, 200, 'text/html', renderPage(`Vòng ${roundNumber} - ${religion}`, body, username));
            return;
        }
        if (req.method === 'POST') {
            let bodyData = '';
            req.on('data', chunk => { bodyData += chunk; });
            req.on('end', async () => {
                const form = querystring.parse(bodyData);
                const decision = (form.decision || '').trim();
                if (!decision) {
                    res.writeHead(302, { Location: '/game' });
                    res.end();
                    return;
                }
                const game = session.game;
                try {
                    const result = await evaluateDecision(decision, {
                        religion: game.religion,
                        followers: game.followers,
                        round: game.round
                    });
                    if (result.violation) {
                        game.followers = 0;
                        game.history.push({ round: game.round, decision: decision, change: 'Vi phạm', comment: result.comment });
                        game.lastFeedback = result;
                        game.round = 11;
                        res.writeHead(302, { Location: '/end' });
                        res.end();
                        return;
                    }
                    game.followers += result.change;
                    if (game.followers < 0) game.followers = 0;
                    game.history.push({ round: game.round, decision: decision, change: result.change, comment: result.comment, tips: result.tips });
                    game.lastFeedback = result;
                    game.round += 1;
                    res.writeHead(302, { Location: '/game' });
                    res.end();
                } catch (err) {
                    console.error('Decision evaluation failed:', err.message || err);
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Đánh giá quyết định thất bại.');
                }
            });
            return;
        }
    }

    // End page
    if (pathname === '/end') {
        if (!username || !session || !session.game) {
            res.writeHead(302, { Location: '/' });
            res.end();
            return;
        }

        const game = session.game;
        const finalFollowers = game.followers;
        const religionName = game.religion;
        const lastFeedback = game.lastFeedback || null;
        let message;
        if (lastFeedback && lastFeedback.violation) {
            message = 'Bạn đã vi phạm các quy định của Nhà nước, tôn giáo của bạn sẽ bị xóa bỏ.';
        } else if (finalFollowers < 600) {
            message = `Những chính sách tôn giáo bạn đề xuất đã không thể phát triển tôn giáo "${religionName}" của bạn. Tôn giáo của bạn có thể sẽ không thể tồn tại trong thời kỳ xã hội chủ nghĩa, bạn hãy cố lên.`;
        } else if (finalFollowers < 1000) {
            message = `Chúc mừng bạn, tôn giáo "${religionName}" của bạn đã phát triển tốt và tồn tại trong thời kỳ xã hội chủ nghĩa nhờ những chính sách và phương hướng bạn đưa ra.`;
        } else {
            message = `Bạn là đấng cứu thế, là thần sáng lập ra tôn giáo "${religionName}" phát triển mạnh mẽ, bền vững lâu dài và phồn thịnh trong thời kỳ xã hội chủ nghĩa. Những chính sách bạn đưa ra là tiền đề cho sự thành công của tôn giáo.`;
        }
        // Update scoreboard if score >= 1000
        let scoreboard = loadScoreboard();
        if (finalFollowers >= 600) {
            scoreboard.push({ username: username, religion: religionName, score: finalFollowers });
            scoreboard.sort((a, b) => b.score - a.score);
            saveScoreboard(scoreboard);
        }
        // Reset game state
        session.game = null;
        const body = `<h2>Kết quả</h2><p>Số người theo đạo cuối cùng của bạn: <strong>${finalFollowers}</strong></p><p>${message}</p><p><a href="/start" class="button">Chơi lại</a></p><p><a href="/leaderboard" class="button">Xem bảng xếp hạng</a></p>`;
        sendResponse(res, 200, 'text/html', renderPage('Kết thúc trò chơi', body, username));
        return;
    }

    // Leaderboard page
    if (pathname === '/leaderboard') {
        if (!username) {
            res.writeHead(302, { Location: '/login' });
            res.end();
            return;
        }
        let scoreboard = loadScoreboard();
        scoreboard = scoreboard.filter(entry => entry.score >= 1000);
        let rows = '';
        scoreboard.forEach((entry, index) => {
            rows += `<tr><td>${index + 1}</td><td>${entry.username}</td><td>${entry.religion}</td><td>${entry.score}</td></tr>`;
        });
        const table = scoreboard.length > 0 ? `<table class="leaderboard-table"><thead><tr><th>Hạng</th><th>Tên người dùng</th><th>Tên tôn giáo</th><th>Điểm (số tín đồ)</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>Chưa có người chơi nào đạt trên 1000 điểm.</p>';
        const body = `<h2>Bảng xếp hạng</h2>${table}`;
        sendResponse(res, 200, 'text/html', renderPage('Bảng xếp hạng', body, username));
        return;
    }

    // Default: not found
    sendResponse(res, 404, 'text/plain', '404 Not Found');
});

// Start server
const PORT = process.env.PORT || 7860;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`http://localhost:${PORT}`)
});
