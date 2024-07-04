import { expect } from 'chai';
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseEphemerisFile, generateOEMTFiles } from '../parse.mjs';
import { writeFB } from 'spacedatastandards.org';

describe('Ephemeris File Processing', () => {
    const inputDir = './test/data';
    const outputDir = './test/output';
    const testFile = `MEME_44714_STARLINK-1008_1851109_Operational_1404299400_UNCLASSIFIED.txt`;

    before(() => {
        if (!existsSync(outputDir)) {
            mkdirSync(outputDir);
        }
    });

    afterEach(() => {
        const files = readdirSync(outputDir);
        files.forEach(file => rmSync(join(outputDir, file)));
    });

    it('should parse the ephemeris file correctly', () => {
        const filePath = join(inputDir, testFile);
        const nextOEMT = parseEphemerisFile(filePath);

        expect(nextOEMT).to.have.property('CREATION_DATE');
        expect(nextOEMT).to.have.property('OBJECT');
        expect(nextOEMT.OBJECT).to.have.property('NORAD_CAT_ID');
        expect(nextOEMT.OBJECT).to.have.property('OBJECT_NAME');
        expect(nextOEMT.OBJECT).to.have.property('OBJECT_TYPE');
        expect(nextOEMT.OBJECT).to.have.property('OPS_STATUS_CODE');
        expect(nextOEMT).to.have.property('EPHEMERIS_DATA_BLOCK');
        expect(nextOEMT.EPHEMERIS_DATA_BLOCK).to.be.an('array').that.is.not.empty;
    });

    it('should generate a valid OEMT buffer', () => {
        const filePath = join(inputDir, testFile);
        const nextOEMT = parseEphemerisFile(filePath);
        const oemBuffer = Buffer.from(writeFB(nextOEMT));

        expect(oemBuffer).to.be.instanceOf(Buffer);
        expect(oemBuffer.length).to.be.greaterThan(0);
    });

    it('should generate OEMT files for all ephemeris files in the directory', function () {
        this.timeout(20000); // Increase timeout to 20 seconds
        return generateOEMTFiles(inputDir, outputDir, 1).then(() => {
            console.log('Generation complete');
            const outputFiles = readdirSync(outputDir).filter(file => file.endsWith('.oem'));
            const inputFiles = readdirSync(inputDir).filter(file => file.endsWith('.txt'));
            expect(outputFiles.length).to.equal(inputFiles.length);
        }).catch((err) => {
            console.error('Error in generateOEMTFiles:', err);
        });
    });

    after(() => {
        //const files = readdirSync(outputDir);
        //files.forEach(file => rmSync(join(outputDir, file)));
    });
});
