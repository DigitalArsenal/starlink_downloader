import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { standards, writeFB } from 'spacedatastandards.org';
import cluster from 'cluster';
import os from 'os';
import readline from 'readline';
import cliProgress from 'cli-progress';

const { OEMT, CATT, objectType, opsStatusCode, ephemerisDataBlockT, ephemerisDataLineT, covarianceMatrixLineT, RFMT, refFrame } = standards.OEM;

const promptUser = (question) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y');
        });
    });
};

const clearDirectory = (dir) => {
    if (readdirSync(dir).length) {
        rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true });
};

const parseEphemerisFile = (filePath) => {
    const fileContent = readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim() !== '');

    const filename = basename(filePath, '.txt');
    const [_, noradId, objectName, satelliteId, operationalStatus, startTimeUnix, classification] = filename.split('_');

    const nextOEMT = new OEMT();
    nextOEMT.CLASSIFICATION = classification;
    // Set parsed values
    const nextCAT = new CATT();
    nextCAT.NORAD_CAT_ID = noradId;
    nextCAT.OBJECT_NAME = objectName;
    nextCAT.OBJECT_TYPE = objectType.PAYLOAD;
    nextCAT.OPS_STATUS_CODE = opsStatusCode[operationalStatus.toUpperCase()];
    nextOEMT.OBJECT = nextCAT;
    nextOEMT.ORIGINATOR = 'SPACEX';
    const nextEDB = new ephemerisDataBlockT();
    nextEDB.START_TIME = '';
    nextEDB.STOP_TIME = '';
    nextEDB.STEP_SIZE = '';

    let covariance_frame = '';
    const rF = new RFMT();

    let dataStartIndex = -1;

    // Parse header
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('created:')) {
            nextOEMT.CREATION_DATE = line.split('created:')[1].trim();
        }
        if (line.includes('ephemeris_start:')) {
            nextEDB.START_TIME = line.split('ephemeris_start:')[1].split('ephemeris_stop:')[0].trim();
        }
        if (line.includes('ephemeris_stop:')) {
            nextEDB.STOP_TIME = line.split('ephemeris_stop:')[1].split('step_size:')[0].trim();
        }
        if (line.includes('step_size:')) {
            nextEDB.STEP_SIZE = parseFloat(line.split('step_size:')[1].trim());
        }
        if (line.includes('ephemeris_source:')) {

        }
        if (line.trim() === 'UVW') {
            covariance_frame = line.trim();
            dataStartIndex = i + 1;

            if (refFrame[covariance_frame]) {
                rF.REFERENCE_FRAME = refFrame[covariance_frame];
            } else {
                throw Error(`Reference Frame Not Found: '${covariance_frame}'`);
            }
        }
    }
    // Parse data section
    for (let i = dataStartIndex; i < lines.length; i += 4) {
        let ephemDataBlock = new ephemerisDataBlockT();
        if (i + 3 < lines.length) {

            const stateLine = lines[i].split(/\s+/);
            const covLine1 = lines[i + 1].split(/\s+/);
            const covLine2 = lines[i + 2].split(/\s+/);
            const covLine3 = lines[i + 3].split(/\s+/);

            const epoch = stateLine[0];
            const [year, doy, time] = [epoch.slice(0, 4), epoch.slice(4, 7), epoch.slice(7, 13)];
            const date = new Date(Date.UTC(parseInt(year), 0, parseInt(doy),
                parseInt(time.slice(0, 2)),
                parseInt(time.slice(2, 4)),
                parseInt(time.slice(4, 6))));

            let ephemLine = new ephemerisDataLineT();

            ephemLine.EPOCH = date.toISOString();
            ephemLine.X = parseFloat(stateLine[1]);
            ephemLine.Y = parseFloat(stateLine[2]);
            ephemLine.Z = parseFloat(stateLine[3]);
            ephemLine.X_DOT = parseFloat(stateLine[4]);
            ephemLine.Y_DOT = parseFloat(stateLine[5]);
            ephemLine.Z_DOT = parseFloat(stateLine[6]);

            ephemDataBlock.EPHEMERIS_DATA_LINES.push(ephemLine);

            let covLine = new covarianceMatrixLineT();
            covLine.EPOCH = date.toISOString();
            covLine.COV_REFERENCE_FRAME = rF;
            covLine.CX_X = parseFloat(covLine1[0]);
            covLine.CY_X = parseFloat(covLine1[1]);
            covLine.CY_Y = parseFloat(covLine1[2]);
            covLine.CZ_X = parseFloat(covLine1[3]);
            covLine.CZ_Y = parseFloat(covLine1[4]);
            covLine.CZ_Z = parseFloat(covLine1[5]);
            covLine.CX_DOT_X = parseFloat(covLine1[6]);
            covLine.CX_DOT_Y = parseFloat(covLine2[0]);
            covLine.CX_DOT_Z = parseFloat(covLine2[1]);
            covLine.CX_DOT_X_DOT = parseFloat(covLine2[2]);
            covLine.CY_DOT_X = parseFloat(covLine2[3]);
            covLine.CY_DOT_Y = parseFloat(covLine2[4]);
            covLine.CY_DOT_Z = parseFloat(covLine2[5]);
            covLine.CY_DOT_X_DOT = parseFloat(covLine2[6]);
            covLine.CY_DOT_Y_DOT = parseFloat(covLine3[0]);
            covLine.CZ_DOT_X = parseFloat(covLine3[1]);
            covLine.CZ_DOT_Y = parseFloat(covLine3[2]);
            covLine.CZ_DOT_Z = parseFloat(covLine3[3]);
            covLine.CZ_DOT_X_DOT = parseFloat(covLine3[4]);
            covLine.CZ_DOT_Y_DOT = parseFloat(covLine3[5]);
            covLine.CZ_DOT_Z_DOT = parseFloat(covLine3[6]);
            ephemDataBlock.COVARIANCE_MATRIX_LINES.push(covLine);

        }
        nextOEMT.EPHEMERIS_DATA_BLOCK.push(ephemDataBlock);
    }
    return nextOEMT;
};

const processFile = (file, inputDir, outputDir) => {
    const inputPath = join(inputDir, file);
    const outputPath = join(outputDir, `${basename(file, '.txt')}.oem`);
    const nextOEM = parseEphemerisFile(inputPath);
    writeFileSync(outputPath, writeFB(nextOEM));
};

export const generateOEMTFiles = (inputDir, outputDir, maxCores = 64) => {
    return new Promise((resolve, reject) => {
        const files = readdirSync(inputDir).filter(file => file.endsWith('.txt'));
        const numCPUs = Math.min(os.cpus().length, maxCores);

        if (cluster.isPrimary) {
            console.log(`Master ${process.pid} is running`);
            console.log(`Spinning up ${numCPUs} workers...`);

            let completedFiles = 0;
            let fileIndex = 0;

            // Create a new progress bar instance
            const progressBar = new cliProgress.SingleBar({
                format: 'Processing |{bar}| {percentage}% | {value}/{total} Files',
                barCompleteChar: '\u2588',
                barIncompleteChar: '\u2591',
                hideCursor: true
            });

            // Initialize the progress bar
            progressBar.start(files.length, 0);

            // Fork workers
            for (let i = 0; i < numCPUs; i++) {
                const worker = cluster.fork();

                worker.on('message', message => {
                    if (message.type === 'done') {
                        completedFiles++;
                        progressBar.update(completedFiles);
                        if (fileIndex < files.length) {
                            worker.send({ file: files[fileIndex], inputDir, outputDir });
                            fileIndex++;
                        } else if (completedFiles === files.length) {
                            progressBar.stop();
                            console.log('All files processed');
                            resolve();
                        }
                    }
                });

                if (fileIndex < files.length) {
                    setTimeout(() => {
                        worker.send({ file: files[fileIndex], inputDir, outputDir });
                    }, 2000)
                    fileIndex++;
                }
            }

            cluster.on('exit', (worker, code, signal) => {
                console.log(`Worker ${worker.process.pid} finished`);
            });

        } else {
            process.on('message', message => {
                const { file, inputDir, outputDir } = message;
                processFile(file, inputDir, outputDir);
                process.send({ type: 'done' });
            });
        }
    });
};

const runScript = async () => {
    const inputDir = './ephemerides';
    const outputDir = './oems';

    if (cluster.isPrimary) {
        console.log(`Input directory: ${inputDir}`);
        console.log(`Output directory: ${outputDir}`);

        const shouldClear = await promptUser('Do you want to clear the output directory before processing? (y/n): ');

        if (shouldClear) {
            console.log('Clearing output directory...');
            clearDirectory(outputDir);
        } else {
            console.log('Skipping directory clear. Files may be overwritten.');
        }

        console.log('Starting file processing...');
    }

    await generateOEMTFiles(inputDir, outputDir);

    if (cluster.isPrimary) {
        console.log('Processing complete.');
        process.exit(0);
    }
};

// Only run the script if this file is being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runScript();
}
