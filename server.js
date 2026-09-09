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

app.post('/upload', upload.single('botZip'), (req, res) => {
    try {
        const { botName, token } = req.body;
        if (!req.file || !botName || !token) {
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        }

        const botFolder = path.join(__dirname, 'hosted_bots', botName);
        if (!fs.existsSync(botFolder)) {
            fs.mkdirSync(botFolder, { recursive: true });
        }

        // Extract ZIP
        const zip = new admZip(req.file.path);
        zip.extractAllTo(botFolder, true);

        // Delete temp zip file
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        // Environment variables create karein
        fs.writeFileSync(path.join(botFolder, '.env'), `TOKEN=${token}\nDISCORD_TOKEN=${token}\nPREFIX=!`);

        console.log(`Installing packages for ${botName}...`);

        // Bot packages install karein agar package.json ho
        if (fs.existsSync(path.join(botFolder, 'package.json'))) {
            try {
                execSync('npm install --production', { cwd: botFolder, stdio: 'inherit' });
            } catch (e) {
                console.error("npm install warning:", e.message);
            }
        }

        // Main file detect karein (index.js, bot.js, main.js)
        let entryFile = 'index.js';
        if (fs.existsSync(path.join(botFolder, 'package.json'))) {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(botFolder, 'package.json')));
                if (pkg.main && fs.existsSync(path.join(botFolder, pkg.main))) {
                    entryFile = pkg.main;
                }
            } catch(e) {}
        } else if (fs.existsSync(path.join(botFolder, 'bot.js'))) {
            entryFile = 'bot.js';
        } else if (fs.existsSync(path.join(botFolder, 'main.js'))) {
            entryFile = 'main.js';
        }

        console.log(`Starting bot '${botName}' using ${entryFile}...`);
        
        // Bot ko background me run karein
        const child = spawn('node', [entryFile], { cwd: botFolder, stdio: 'inherit' });

        child.on('error', (err) => {
            console.error(`Failed to start bot process: ${err.message}`);
        });

        res.json({ success: true, message: `Bot '${botName}' process started successfully!` });
    } catch (err) {
        console.error("Upload error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

