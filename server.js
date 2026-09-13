const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });
const botsDir = path.join(__dirname, 'active_bots');

if (!fs.existsSync(botsDir)) fs.mkdirSync(botsDir);

const runningProcesses = {}; 
const botLogs = {};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// User-specific bots fetch karne ke liye (?user=username)
app.get('/bots', (req, res) => {
    try {
        const username = req.query.user || 'default';
        const userFolder = path.join(botsDir, username);

        if (!fs.existsSync(userFolder)) {
            return res.json({ success: true, bots: [] });
        }

        const bots = fs.readdirSync(userFolder).map(name => {
            const processKey = `${username}_${name}`;
            return {
                name,
                status: runningProcesses[processKey] ? 'Running' : 'Stopped'
            };
        });
        res.json({ success: true, bots });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/upload', upload.any(), (req, res) => {
    handleUniversalDeployment(req, res);
});

app.put('/update', upload.any(), (req, res) => {
    handleUniversalDeployment(req, res, true);
});

function handleUniversalDeployment(req, res, isUpdate = false) {
    const username = req.body.username || req.body.user || 'default';
    const botName = req.body.botName || req.body.name || `bot_${Date.now()}`;
    const botToken = req.body.token;

    const userFolderPath = path.join(botsDir, username);
    if (!fs.existsSync(userFolderPath)) fs.mkdirSync(userFolderPath, { recursive: true });

    const botFolderPath = path.join(userFolderPath, botName);
    const processKey = `${username}_${botName}`;

    try {
        if (isUpdate && runningProcesses[processKey]) {
            runningProcesses[processKey].kill();
            delete runningProcesses[processKey];
        }

        if (req.files && req.files.length > 0) {
            const file = req.files[0];
            const zip = new AdmZip(file.path);
            
            if (isUpdate && fs.existsSync(botFolderPath)) {
                fs.rmSync(botFolderPath, { recursive: true, force: true });
            }

            zip.extractAllTo(botFolderPath, true);
            fs.unlinkSync(file.path);
        }

        let actualWorkDir = botFolderPath;
        const items = fs.readdirSync(botFolderPath);
        if (items.length === 1) {
            const subPath = path.join(botFolderPath, items[0]);
            if (fs.statSync(subPath).isDirectory()) {
                actualWorkDir = subPath;
            }
        }

        if (botToken) {
            const envPath = path.join(actualWorkDir, '.env');
            fs.writeFileSync(envPath, `DISCORD_TOKEN=${botToken}\n`);
            console.log(`[${username}/${botName}] Created .env file with provided token.`);
        }

        botLogs[processKey] = [];

        const msg = isUpdate ? `Bot [${botName}] update started!` : `Bot [${botName}] deployment started!`;
        res.json({ success: true, message: msg });

        setImmediate(() => {
            runBackgroundDeployment(actualWorkDir, botName, botToken, username, processKey);
        });

    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
}

function runBackgroundDeployment(actualWorkDir, botName, botToken, username, processKey) {
    try {
        const files = fs.readdirSync(actualWorkDir);

        if (fs.existsSync(path.join(actualWorkDir, 'package.json'))) {
            try {
                execSync('npm install', { cwd: actualWorkDir, stdio: 'inherit' });
            } catch (e) {}

            let entryPoint = 'index.js';
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(actualWorkDir, 'package.json'), 'utf8'));
                if (pkg.main) entryPoint = pkg.main;
            } catch (e) {}
            if (!fs.existsSync(path.join(actualWorkDir, entryPoint))) {
                if (fs.existsSync(path.join(actualWorkDir, 'server.js'))) entryPoint = 'server.js';
                else if (fs.existsSync(path.join(actualWorkDir, 'bot.js'))) entryPoint = 'bot.js';
            }
            startBotProcess('node', [entryPoint], actualWorkDir, botName, botToken, processKey);
        } else {
            let scriptName = null;
            const priorities = ['run_bot.py', 'main.py', 'bot.py', 'app.py', 'index.py'];
            for (let p of priorities) {
                if (files.includes(p)) {
                    scriptName = p;
                    break;
                }
            }
            
            if (!scriptName) {
                const pyFile = files.find(f => f.endsWith('.py'));
                if (pyFile) scriptName = pyFile;
            }

            if (scriptName) {
                const reqPath = path.join(actualWorkDir, 'requirements.txt');
                if (!fs.existsSync(reqPath)) {
                    fs.writeFileSync(reqPath, 'discord.py\nPyNaCl\nrequests\nyt-dlp\nPillow\npython-dotenv\n');
                } else {
                    let reqContent = fs.readFileSync(reqPath, 'utf8');
                    if (!reqContent.includes('Pillow')) reqContent += '\nPillow';
                    if (!reqContent.includes('python-dotenv')) reqContent += '\npython-dotenv';
                    fs.writeFileSync(reqPath, reqContent);
                }

                try {
                    console.log(`Creating Virtual Environment for ${username}/${botName}...`);
                    execSync('python3 -m venv venv', { cwd: actualWorkDir, stdio: 'inherit' });

                    console.log(`Installing dependencies inside venv for ${username}/${botName}...`);
                    const pipPath = process.platform === 'win32' 
                        ? path.join(actualWorkDir, 'venv', 'Scripts', 'pip')
                        : path.join(actualWorkDir, 'venv', 'bin', 'pip');

                    execSync(`"${pipPath}" install --upgrade pip`, { cwd: actualWorkDir, stdio: 'inherit' });
                    execSync(`"${pipPath}" install -r requirements.txt`, { cwd: actualWorkDir, stdio: 'inherit' });
                } catch (venvErr) {
                    console.error(`Venv error: ${venvErr.message}`);
                }

                const pythonPath = process.platform === 'win32'
                    ? path.join(actualWorkDir, 'venv', 'Scripts', 'python')
                    : path.join(actualWorkDir, 'venv', 'bin', 'python');

                startBotProcess(pythonPath, [scriptName], actualWorkDir, botName, botToken, processKey);
            } else if (files.some(f => f.endsWith('.jar'))) {
                const jarFile = files.find(f => f.endsWith('.jar'));
                startBotProcess('java', ['-jar', jarFile], actualWorkDir, botName, botToken, processKey);
            } else {
                const anyScript = files.find(f => f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.sh') || f.endsWith('.rb') || f.endsWith('.go'));
                if (anyScript) {
                    const ext = path.extname(anyScript);
                    if (ext === '.js') startBotProcess('node', [anyScript], actualWorkDir, botName, botToken, processKey);
                    else if (ext === '.py') startBotProcess('python3', [anyScript], actualWorkDir, botName, botToken, processKey);
                    else startBotProcess('node', [anyScript], actualWorkDir, botName, botToken, processKey);
                }
            }
        }
    } catch (bgErr) {
        console.error(`Background deployment error for [${username}/${botName}]: ${bgErr.message}`);
    }
}

function startBotProcess(command, args, cwd, botName, botToken, processKey) {
    if (runningProcesses[processKey]) {
        runningProcesses[processKey].kill();
    }

    const env = Object.assign({}, process.env);
    if (botToken) {
        env.DISCORD_TOKEN = botToken;
    }

    const botProcess = spawn(command, args, { cwd, shell: true, env });
    runningProcesses[processKey] = botProcess;

    botProcess.stdout.on('data', (data) => {
        const logMsg = `[OUT]: ${data.toString()}`;
        console.log(`[${processKey}] ${logMsg}`);
        if (!botLogs[processKey]) botLogs[processKey] = [];
        botLogs[processKey].push(logMsg);
        if (botLogs[processKey].length > 100) botLogs[processKey].shift();
    });

    botProcess.stderr.on('data', (data) => {
        const logMsg = `[ERR]: ${data.toString()}`;
        console.error(`[${processKey}] ${logMsg}`);
        if (!botLogs[processKey]) botLogs[processKey] = [];
        botLogs[processKey].push(logMsg);
        if (botLogs[processKey].length > 100) botLogs[processKey].shift();
    });

    botProcess.on('close', (code) => {
        const exitMsg = `Process exited with code ${code}`;
        console.log(`[${processKey}] ${exitMsg}`);
        if (!botLogs[processKey]) botLogs[processKey] = [];
        botLogs[processKey].push(exitMsg);
        delete runningProcesses[processKey];
    });
}

app.post('/stop/:username/:name', (req, res) => {
    const { username, name } = req.params;
    const processKey = `${username}_${name}`;
    if (runningProcesses[processKey]) {
        runningProcesses[processKey].kill();
        delete runningProcesses[processKey];
        res.json({ success: true, message: `Bot ${name} stopped successfully.` });
    } else {
        res.status(404).json({ error: 'Bot is not currently running.' });
    }
});

app.delete('/delete/:username/:name', (req, res) => {
    const { username, name } = req.params;
    const processKey = `${username}_${name}`;
    const botFolderPath = path.join(botsDir, username, name);
    
    if (runningProcesses[processKey]) {
        runningProcesses[processKey].kill();
        delete runningProcesses[processKey];
    }
    
    if (fs.existsSync(botFolderPath)) {
        fs.rmSync(botFolderPath, { recursive: true, force: true });
        delete botLogs[processKey];
        res.json({ success: true, message: `Bot ${name} deleted successfully.` });
    } else {
        res.status(404).json({ error: 'Bot folder not found.' });
    }
});

app.get('/logs/:username/:name', (req, res) => {
    const { username, name } = req.params;
    const processKey = `${username}_${name}`;
    res.json({ success: true, logs: botLogs[processKey] || [] });
});

app.listen(PORT, () => {
    console.log(`Zyrax Unified Backend running on port ${PORT}`);
});

