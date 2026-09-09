const express = require('express');
const multer = require('multer');
const admZip = require('adm-zip');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { spawn } = require('child_process');

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

        const zip = new admZip(req.file.path);
        zip.extractAllTo(botFolder, true);

        fs.writeFileSync(path.join(botFolder, '.env'), `TOKEN=${token}\nDISCORD_TOKEN=${token}`);

        const child = spawn('node', ['.'], { cwd: botFolder, stdio: 'inherit' });

        res.json({ success: true, message: `Bot '${botName}' deployed successfully!` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

