const express = require('express');
const multer = require('multer');
const admZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { execSync, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

app.get('/', (req, res) => {
    res.send('Zyrax Backend Server Active & Running!');
});

// Helper: Zip ke andar kisi bhi subfolder me main file dhundhne ke liye
function findBotDirectoryAndEntry(dir) {
    // 1. Check package.json
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) {
                return { cwd: dir, entry: pkg.main };
            }
        } catch(e) {}
    }

    // 2. Common filenames check karein
    const candidates = ['index.js', 'bot.js', 'main.js', 'app.js', 'src/index.js'];
    for (const file of candidates) {
        if (fs.existsSync(path.join(dir, file))) {
            return { cwd: dir, entry: file };
        }
    }

    // 3. Agar Zip ke andar koi subfolder ho, to uske andar search karein
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isDirectory() && item !== 'node_modules' && !item.startsWith('.')) {
            const result = findBotDirectoryAndEntry(fullPath);
            if (result) return result;
        }
    }

    return null;
}

app.post('/upload', upload.single('botZip'), (req, res) => {
    try {
        const { botName, token } = req.body;
        if (!req.file || !botName || !token) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        const rawBotFolder = path.join(__dirname, 'hosted_bots', botName);
        if (fs.existsSync(rawBotFolder)) {
            fs.rmSync(rawBotFolder, { recursive: true, force: true });
        }
        fs.mkdirSync(rawBotFolder, { recursive: true });

        // Extract ZIP
        const zip = new admZip(req.file.path);
        zip.extractAllTo(rawBotFolder, true);

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        // Auto-detect bot subfolder & main file
        const botTarget = findBotDirectoryAndEntry(rawBotFolder);

        if (!botTarget) {
            return res.status(400).json({ 
                success: false, 
                message: 'ZIP me main file (index.js / bot.js / main.js) nahi mili.' 
            });
        }

        const botFolder = botTarget.cwd;
        const entryFile = botTarget.entry;

        console.log(`[ZYRAX] Bot Directory: ${botFolder}`);
        console.log(`[ZYRAX] Launching File: ${entryFile}`);

        // Generate .env & config.json
        fs.writeFileSync(path.join(botFolder, '.env'), `TOKEN=${token}\nDISCORD_TOKEN=${token}\nBOT_TOKEN=${token}\nPREFIX=!`);
        
        const configData = { token: token, prefix: "!", DISCORD_TOKEN: token, BOT_TOKEN: token };
        fs.writeFileSync(path.join(botFolder, 'config.json'), JSON.stringify(configData, null, 2));

        console.log(`[ZYRAX] Installing npm modules for ${botName}...`);

        if (fs.existsSync(path.join(botFolder, 'package.json'))) {
            try {
                execSync('npm install --production', { cwd: botFolder, stdio: 'inherit' });
            } catch (e) {
                console.error("[ZYRAX] npm install warning:", e.message);
            }
        }

        console.log(`[ZYRAX] Starting process for ${botName}...`);

        // Launch Bot Process
        const child = spawn('node', [entryFile], { cwd: botFolder, stdio: 'inherit' });

        child.on('error', (err) => {
            console.error(`[ZYRAX ERROR] Bot failed to start: ${err.message}`);
        });

        res.json({ success: true, message: `Bot '${botName}' started successfully!` });
    } catch (err) {
        console.error("[ZYRAX ERROR]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
