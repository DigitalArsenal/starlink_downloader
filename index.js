const https = require('https');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// URL to the manifest file
const manifestUrl = 'https://api.starlink.com/public-files/ephemerides/MANIFEST.txt';

// Directory to save the ephemeris files
const outputDir = path.join(__dirname, 'ephemerides');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// Function to download a file
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest);
            reject(err);
        });
    });
}

// Function to read the manifest and download files
async function downloadEphemerides() {
    const manifestStream = https.get(manifestUrl, (response) => {
        if (response.statusCode !== 200) {
            console.error(`Failed to get '${manifestUrl}' (${response.statusCode})`);
            return;
        }
        const rl = readline.createInterface({
            input: response,
            crlfDelay: Infinity
        });

        rl.on('line', async (line) => {
            if (line.trim()) {
                const fileUrl = `https://api.starlink.com/public-files/ephemerides/${line.trim()}`;
                const fileName = path.basename(fileUrl);
                const filePath = path.join(outputDir, fileName);
                try {
                    await downloadFile(fileUrl, filePath);
                    console.log(`Downloaded: ${fileName}`);
                } catch (err) {
                    console.error(`Failed to download ${fileName}: ${err.message}`);
                }
            }
        });

        rl.on('close', () => {
            console.log('Finished processing manifest.');
        });
    });

    manifestStream.on('error', (err) => {
        console.error(`Failed to download manifest file: ${err.message}`);
    });
}

// Start the download process
downloadEphemerides();
