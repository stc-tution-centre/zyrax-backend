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

function locateBotEntry(dir) {
    const pyCandidates = ['main.py', 'bot.py', 'index.py'];
    for (const file of pyCandidates) {
        if (fs.existsSync(path.join(dir, file))) {
            return { cwd: dir, entry: file, runner: 'python3' };
        }
    }

    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.main && fs.existsSync(path.join(dir, pkg.main))) {
                return { cwd: dir, entry: pkg.main, runner: 'node' };
            }
        } catch(e) {}
    }

    const jsCandidates = ['index.js', 'bot.js', 'main.js', 'app.js', 'src/index.js'];
    for (const file of jsCandidates) {
        if (fs.existsSync(path.join(dir, file))) {
            return { cwd: dir, entry: file, runner: 'node' };
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
            return res.status(400).json({ success: false, message: 'No valid entry file found.' });
        }

        const botFolder = botTarget.cwd;
        const cleanToken = token.trim();

        // Write environment & config files
        fs.writeFileSync(path.join(botFolder, '.env'), `TOKEN=${cleanToken}\nDISCORD_TOKEN=${cleanToken}\nBOT_TOKEN=${cleanToken}\nPREFIX=!`);
        const configData = { token: cleanToken, prefix: "!", DISCORD_TOKEN: cleanToken, BOT_TOKEN: cleanToken };
        fs.writeFileSync(path.join(botFolder, 'config.json'), JSON.stringify(configData, null, 2));

        if (botTarget.runner === 'python3') {
            console.log(`[ZYRAX] Creating Python Virtual Environment for ${botName}...`);
            try {
                execSync('python3 -m venv venv', { cwd: botFolder, stdio: 'inherit' });
                
                const pipPath = path.join(botFolder, 'venv', 'bin', 'pip');
                const pythonEnvPath = path.join(botFolder, 'venv', 'bin', 'python');

                if (fs.existsSync(path.join(botFolder, 'requirements.txt'))) {
                    console.log(`[ZYRAX] Installing requirements.txt inside venv...`);
                    execSync(`"${pipPath}" install -r requirements.txt`, { cwd: botFolder, stdio: 'inherit' });
                } else {
                    console.log(`[ZYRAX] Installing discord.py inside venv...`);
                    execSync(`"${pipPath}" install discord.py PyNaCl`, { cwd: botFolder, stdio: 'inherit' });
                }

                // Override runner to use venv python
                botTarget.runner = pythonEnvPath;
            } catch (e) {
                console.error("Venv setup error:", e.message);
            }
        } else {
            console.log(`[ZYRAX] Installing Node.js packages for ${botName}...`);
            if (fs.existsSync(path.join(botFolder, 'package.json'))) {
                try {
                    execSync('npm install --production', { cwd: botFolder, stdio: 'inherit' });
                } catch (e) {}
            }
        }

        console.log(`[ZYRAX] Starting bot '${botName}'...`);

        const child = spawn(botTarget.runner, [botTarget.entry], { 
            cwd: botFolder, 
            env: { ...process.env, TOKEN: cleanToken, DISCORD_TOKEN: cleanToken, BOT_TOKEN: cleanToken } 
        });

        child.stdout.on('data', (data) => console.log(`[BOT]: ${data}`));
        child.stderr.on('data', (data) => console.error(`[BOT ERROR]: ${data}`));

        res.json({ success: true, message: `Bot '${botName}' started successfully!` });
    } catch (err) {
        console.error("Upload error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
      
