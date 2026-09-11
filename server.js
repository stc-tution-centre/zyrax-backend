const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
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

app.get('/bots', (req, res) => {
    try {
        if (!fs.existsSync(botsDir)) {
            return res.json({ success: true, bots: [] });
        }
        const bots = fs.readdirSync(botsDir).map(name => {
            return {
                name,
                status: runningProcesses[name] ? 'Running' : 'Stopped'
            };
        });
        res.json({ success: true, bots });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Universal Upload - Supports ANY Language / ANY File structure
app.post('/upload', upload.any(), (req, res) => {
    handleUniversalDeployment(req, res);
});

app.put('/update', upload.any(), (req, res) => {
    handleUniversalDeployment(req, res, true);
});

function handleUniversalDeployment(req, res, isUpdate = false) {
    const botName = req.body.botName || req.body.name || `bot_${Date.now()}`;
    const botFolderPath = path.join(botsDir, botName);

    try {
        if (isUpdate && runningProcesses[botName]) {
            runningProcesses[botName].kill();
            delete runningProcesses[botName];
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

        // Handle nested folders automatically (if zip contains a single root folder)
        let actualWorkDir = botFolderPath;
        const items = fs.readdirSync(botFolderPath);
        if (items.length === 1) {
            const subPath = path.join(botFolderPath, items[0]);
            if (fs.statSync(subPath).isDirectory()) {
                actualWorkDir = subPath;
            }
        }

        botLogs[botName] = [];

        // Universal Detection & Execution
        const files = fs.readdirSync(actualWorkDir);

        // 1. Node.js / JavaScript / TypeScript
        if (fs.existsSync(path.join(actualWorkDir, 'package.json'))) {
            const installProc = spawn('npm', ['install'], { cwd: actualWorkDir, shell: true });
            installProc.on('close', (code) => {
                let entryPoint = 'index.js';
                try {
                    const pkg = JSON.parse(fs.readFileSync(path.join(actualWorkDir, 'package.json'), 'utf8'));
                    if (pkg.main) entryPoint = pkg.main;
                } catch (e) {}
                if (!fs.existsSync(path.join(actualWorkDir, entryPoint))) {
                    if (fs.existsSync(path.join(actualWorkDir, 'server.js'))) entryPoint = 'server.js';
                    else if (fs.existsSync(path.join(actualWorkDir, 'bot.js'))) entryPoint = 'bot.js';
                }
                startBotProcess('node', [entryPoint], actualWorkDir, botName);
            });
        } 
        // 2. Python (Any .py file like run_bot.py, main.py, bot.py, etc.)
        else {
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
                if (fs.existsSync(path.join(actualWorkDir, 'requirements.txt'))) {
                    const pipProc = spawn('pip', ['install', '-r', 'requirements.txt'], { cwd: actualWorkDir, shell: true });
                    pipProc.on('close', () => {
                        startBotProcess('python', [scriptName], actualWorkDir, botName);
                    });
                } else {
                    startBotProcess('python', [scriptName], actualWorkDir, botName);
                }
            } 
            // 3. Java (.jar)
            else if (files.some(f => f.endsWith('.jar'))) {
                const jarFile = files.find(f => f.endsWith('.jar'));
                startBotProcess('java', ['-jar', jarFile], actualWorkDir, botName);
            } 
            // 4. Fallback for other scripts
            else {
                const anyScript = files.find(f => f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.sh') || f.endsWith('.rb') || f.endsWith('.go'));
                if (anyScript) {
                    const ext = path.extname(anyScript);
                    if (ext === '.js') startBotProcess('node', [anyScript], actualWorkDir, botName);
                    else if (ext === '.py') startBotProcess('python', [anyScript], actualWorkDir, botName);
                    else if (ext === '.go') startBotProcess('go', ['run', anyScript], actualWorkDir, botName);
                    else startBotProcess('node', [anyScript], actualWorkDir, botName);
                } else {
                    return res.status(400).json({ error: 'No executable script or recognized structure found in zip!' });
                }
            }
        }

        const msg = isUpdate ? `Bot [${botName}] updated successfully!` : `Bot [${botName}] uploaded and running!`;
        res.json({ success: true, message: msg });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

function startBotProcess(command, args, cwd, botName) {
    if (runningProcesses[botName]) {
        runningProcesses[botName].kill();
    }

    const botProcess = spawn(command, args, { cwd, shell: true });
    runningProcesses[botName] = botProcess;

    botProcess.stdout.on('data', (data) => {
        const logMsg = `[OUT]: ${data.toString()}`;
        console.log(`[${botName}] ${logMsg}`);
        if (!botLogs[botName]) botLogs[botName] = [];
        botLogs[botName].push(logMsg);
        if (botLogs[botName].length > 100) botLogs[botName].shift();
    });

    botProcess.stderr.on('data', (data) => {
        const logMsg = `[ERR]: ${data.toString()}`;
        console.error(`[${botName}] ${logMsg}`);
        if (!botLogs[botName]) botLogs[botName] = [];
        botLogs[botName].push(logMsg);
        if (botLogs[botName].length > 100) botLogs[botName].shift();
    });

    botProcess.on('close', (code) => {
        const exitMsg = `Process exited with code ${code}`;
        console.log(`[${botName}] ${exitMsg}`);
        if (!botLogs[botName]) botLogs[botName] = [];
        botLogs[botName].push(exitMsg);
        delete runningProcesses[botName];
    });
}

app.post('/stop/:name', (req, res) => {
    const { name } = req.params;
    if (runningProcesses[name]) {
        runningProcesses[name].kill();
        delete runningProcesses[name];
        res.json({ success: true, message: `Bot ${name} stopped successfully.` });
    } else {
        res.status(404).json({ error: 'Bot is not currently running.' });
    }
});

app.delete('/delete/:name', (req, res) => {
    const { name } = req.params;
    const botFolderPath = path.join(botsDir, name);
    
    if (runningProcesses[name]) {
        runningProcesses[name].kill();
        delete runningProcesses[name];
    }
    
    if (fs.existsSync(botFolderPath)) {
        fs.rmSync(botFolderPath, { recursive: true, force: true });
        delete botLogs[name];
        res.json({ success: true, message: `Bot ${name} deleted successfully.` });
    } else {
        res.status(404).json({ error: 'Bot folder not found.' });
    }
});

app.get('/logs/:name', (req, res) => {
    const { name } = req.params;
    res.json({ success: true, logs: botLogs[name] || [] });
});

app.listen(PORT, () => {
    console.log(`Zyrax Unified Backend running on port ${PORT}`);
});
