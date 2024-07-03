# Ephemeris Processing Tool

This project provides a tool to process ephemeris files from the Starlink public repository and convert them to OEMT (Orbital Ephemeris Message Type) files using the Space Data Standards library.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Directory Structure](#directory-structure)
- [Configuration](#configuration)
- [Reference](#reference)

## Installation

1. Clone the repository:

   ```sh
   git clone https://github.com/your-repo/ephemeris-processing-tool.git
   cd ephemeris-processing-tool
   ```

2. Install the required dependencies:

   ```sh
   npm install
   ```

## Usage

To process the ephemeris files, run the script with Node.js:

```sh
node index.js
```

## Directory Structure

- ./ephemerides: Directory containing input ephemeris .txt files.
- ./oems: Directory where output OEMT .oem files will be saved.

## Configuration

You can configure the input and output directories and the maximum number of CPU cores to use by modifying the generateOEMTFiles function parameters.

## Example

generateOEMTFiles('./ephemerides', './oems', 32);

## Reference

The input ephemeris files follow the format provided in the Starlink public repository. For more information on the file format and structure, refer to the Starlink Ephemeris README.

## License

This project is licensed under the MIT License. See the LICENSE file for details.
