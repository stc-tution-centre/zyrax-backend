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

// Recursive function to locate main bot file or directory
function locateBotEntry(dir) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) {
                return { cwd: dir, entry: pkg.main, runner: 'node' };
            }
            if (pkg.scripts && pkg.scripts.start) {
                return { cwd: dir, entry: 'npm', isScript: true };
            }
        } catch(e) {}
    }

    const jsCandidates = ['index.js', 'bot.js', 'main.js', 'app.js', 'src/index.js', 'src/bot.js'];
    for (const file of jsCandidates) {
        if (fs.existsSync(path.join(dir, file))) {
            return { cwd: dir, entry: file, runner: 'node' };
        }
    }

    const tsCandidates = ['index.ts', 'bot.ts', 'src/index.ts', 'src/bot.ts'];
    for (const file of tsCandidates) {
        if (fs.existsSync(path.join(dir, file))) {
            return { cwd: dir, entry: file, runner: 'ts-node' };
        }
    }

    const pyCandidates = ['main.py', 'bot.py', 'index.py'];
    for (const file of pyCandidates) {
        if (fs.existsSync(path.join(dir, file))) {
            return { cwd: dir, entry: file, runner: 'python3' };
        }
    }

    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        if (fs.statSync(fullPath).isDirectory() && item !== 'node_modules' && !item.startsWith('.')) {
            const result = locateBotEntry(fullPath);
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

        const zip = new admZip(req.file.path);
        zip.extractAllTo(rawBotFolder, true);
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        const botTarget = locateBotEntry(rawBotFolder);

        if (!botTarget) {
            return res.status(400).json({ 
                success: false, 
                message: 'ZIP contents incompatible. No valid entry file found.' 
            });
        }

        const botFolder = botTarget.cwd;
        fs.writeFileSync(path.join(botFolder, '.env'), `TOKEN=${token}\nDISCORD_TOKEN=${token}\nBOT_TOKEN=${token}\nPREFIX=!`);
        
        const configData = { token: token, prefix: "!", DISCORD_TOKEN: token, BOT_TOKEN: token };
        fs.writeFileSync(path.join(botFolder, 'config.json'), JSON.stringify(configData, null, 2));

        if (fs.existsSync(path.join(botFolder, 'package.json'))) {
            try {
                execSync('npm install --production', { cwd: botFolder, stdio: 'inherit' });
            } catch (e) {
                console.error("npm install warning:", e.message);
            }
        }

        let child;
        if (botTarget.isScript) {
            child = spawn('npm', ['start'], { cwd: botFolder, stdio: 'inherit' });
        } else {
            child = spawn(botTarget.runner, [botTarget.entry], { cwd: botFolder, stdio: 'inherit' });
        }

        child.on('error', (err) => {
            console.error(`Bot start error: ${err.message}`);
        });

        res.json({ success: true, message: `Bot '${botName}' hosted successfully!` });
    } catch (err) {
        console.error("Upload error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
