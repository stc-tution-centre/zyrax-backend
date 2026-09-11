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

// Universal Upload & Flexible Execution
app.post('/upload', upload.any(), (req, res) => {
    handleBotDeployment(req, res);
});

app.put('/update', upload.any(), (req, res) => {
    handleBotDeployment(req, res, true);
});

function handleBotDeployment(req, res, isUpdate = false) {
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

        if (!fs.existsSync(botFolderPath)) {
            return res.status(400).json({ error: 'Bot folder not found or extraction failed!' });
        }

        botLogs[botName] = [];

        // Check for Node.js Project
        if (fs.existsSync(path.join(botFolderPath, 'package.json'))) {
            const installProc = spawn('npm', ['install'], { cwd: botFolderPath, shell: true });
            installProc.on('close', (code) => {
                if (code === 0) {
                    let entryPoint = 'index.js';
                    try {
                        const pkg = JSON.parse(fs.readFileSync(path.join(botFolderPath, 'package.json'), 'utf8'));
                        if (pkg.main) entryPoint = pkg.main;
                    } catch (e) {}
                    if (!fs.existsSync(path.join(botFolderPath, entryPoint))) {
                        entryPoint = fs.existsSync(path.join(botFolderPath, 'server.js')) ? 'server.js' : 'index.js';
                    }
                    startBotProcess('node', [entryPoint], botFolderPath, botName);
                } else {
                    botLogs[botName].push(`[ERR]: Dependency installation failed with code ${code}`);
                }
            });
        } 
        // Universal Python Project Detection (Supports main.py, bot.py, run_bot.py or any .py file)
        else {
            let scriptName = null;
            const possibleNames = ['main.py', 'bot.py', 'run_bot.py', 'app.py', 'index.py'];
            
            for (let name of possibleNames) {
                if (fs.existsSync(path.join(botFolderPath, name))) {
                    scriptName = name;
                    break;
                }
            }

            // If specific names not found, pick the first .py file available in the folder
            if (!scriptName) {
                const files = fs.readdirSync(botFolderPath);
                const pyFile = files.find(f => f.endsWith('.py'));
                if (pyFile) scriptName = pyFile;
            }

            if (scriptName) {
                const reqPath = path.join(botFolderPath, 'requirements.txt');
                const pyprojectPath = path.join(botFolderPath, 'pyproject.toml');

                if (fs.existsSync(reqPath)) {
                    const pipProc = spawn('pip', ['install', '-r', 'requirements.txt'], { cwd: botFolderPath, shell: true });
                    pipProc.on('close', () => {
                        startBotProcess('python', [scriptName], botFolderPath, botName);
                    });
                } else if (fs.existsSync(pyprojectPath) && fs.existsSync(path.join(botFolderPath, 'uv.lock'))) {
                    // Support for uv/pyproject projects if present
                    const uvProc = spawn('pip', ['install', '.'], { cwd: botFolderPath, shell: true });
                    uvProc.on('close', () => {
                        startBotProcess('python', [scriptName], botFolderPath, botName);
                    });
                } else {
                    startBotProcess('python', [scriptName], botFolderPath, botName);
                }
            } else {
                return res.status(400).json({ error: 'Unsupported structure! Include package.json or a Python script (.py like run_bot.py, main.py).' });
            }
        }

        const msg = isUpdate ? `Bot [${botName}] updated and restarted successfully!` : `Bot [${botName}] uploaded and deploying successfully!`;
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
