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

// Track active bot processes and real-time logs
const runningProcesses = {}; 
const botLogs = {};

// 1. Health check for UptimeRobot (24/7 uptime)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
})

// 2. Fetch all hosted/active bots with status
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

// 3. Universal Upload, Auto-Detect Language, Install Deps & Run Bot
app.post('/upload', upload.any(), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No file uploaded!' });
    const file = req.files[0];

    const botName = req.body.botName || req.body.name || `bot_${Date.now()}`;
    const botFolderPath = path.join(botsDir, botName);

    try {
        // Extract zip archive
        const zip = new AdmZip(file.path);
        zip.extractAllTo(botFolderPath, true);
        fs.unlinkSync(file.path); // Clean temp zip file

        // Kill existing process if updating the same bot
        if (runningProcesses[botName]) {
            runningProcesses[botName].kill();
            delete runningProcesses[botName];
        }

        botLogs[botName] = [];

        // Detect project type & start execution
        if (fs.existsSync(path.join(botFolderPath, 'package.json'))) {
            // Node.js Bot (Discord.js, Music, Nuke, Mod, etc.)
            const installProc = spawn('npm', ['install'], { cwd: botFolderPath, shell: true });
            
            installProc.on('close', (code) => {
                if (code === 0) {
                    // Try to detect main file from package.json or default to index.js/server.js
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
        } else if (fs.existsSync(path.join(botFolderPath, 'main.py')) || fs.existsSync(path.join(botFolderPath, 'bot.py'))) {
            // Python Bot Support
            const scriptName = fs.existsSync(path.join(botFolderPath, 'main.py')) ? 'main.py' : 'bot.py';
            
            if (fs.existsSync(path.join(botFolderPath, 'requirements.txt'))) {
                const pipProc = spawn('pip', ['install', '-r', 'requirements.txt'], { cwd: botFolderPath, shell: true });
                pipProc.on('close', () => {
                    startBotProcess('python', [scriptName], botFolderPath, botName);
                });
            } else {
                startBotProcess('python', [scriptName], botFolderPath, botName);
            }
        } else {
            return res.status(400).json({ error: 'Unsupported structure! Include package.json (Node) or main.py (Python).' });
        }

        res.json({ success: true, message: `Bot [${botName}] uploaded and deploying successfully!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3.5. Update existing bot (Token or Zip)
app.put('/update', upload.any(), (req, res) => {
    const botName = req.body.botName;
    if (!botName) return res.status(400).json({ error: 'Bot name is required for update!' });

    const botFolderPath = path.join(botsDir, botName);

    try {
        if (req.files && req.files.length > 0) {
            const file = req.files[0];
            const zip = new AdmZip(file.path);
            
            if (runningProcesses[botName]) {
                runningProcesses[botName].kill();
                delete runningProcesses[botName];
            }

            if (fs.existsSync(botFolderPath)) {
                fs.rmSync(botFolderPath, { recursive: true, force: true });
            }

            zip.extractAllTo(botFolderPath, true);
            fs.unlinkSync(file.path);

            botLogs[botName] = [];

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
                    }
                });
            } else if (fs.existsSync(path.join(botFolderPath, 'main.py')) || fs.existsSync(path.join(botFolderPath, 'bot.py'))) {
                const scriptName = fs.existsSync(path.join(botFolderPath, 'main.py')) ? 'main.py' : 'bot.py';
                if (fs.existsSync(path.join(botFolderPath, 'requirements.txt'))) {
                    const pipProc = spawn('pip', ['install', '-r', 'requirements.txt'], { cwd: botFolderPath, shell: true });
                    pipProc.on('close', () => {
                        startBotProcess('python', [scriptName], botFolderPath, botName);
                    });
                } else {
                    startBotProcess('python', [scriptName], botFolderPath, botName);
                }
            }
        }

        res.json({ success: true, message: `Bot [${botName}] updated and restarted successfully!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper function to manage child process lifecycle & capture logs
function startBotProcess(command, args, cwd, botName) {
    const botProcess = spawn(command, args, { cwd, shell: true });
    runningProcesses[botName] = botProcess;

    botProcess.stdout.on('data', (data) => {
        const logMsg = `[OUT]: ${data.toString()}`;
        console.log(`[${botName}] ${logMsg}`);
        if (!botLogs[botName]) botLogs[botName] = [];
        botLogs[botName].push(logMsg);
        if (botLogs[botName].length > 100) botLogs[botName].shift(); // Keep last 100 lines
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

// 4. Stop a running bot
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

// 5. Delete a bot completely from storage
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

// 6. Stream live logs to frontend dashboard
app.get('/logs/:name', (req, res) => {
    const { name } = req.params;
    res.json({ success: true, logs: botLogs[name] || [] });
});

app.listen(PORT, () => {
    console.log(`Zyrax Unified Backend running on port ${PORT}`);
});
