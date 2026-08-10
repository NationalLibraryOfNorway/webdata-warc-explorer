# WARC Explorer
A tiny application for client-side exploration of WARC files and records in a browser.

Built as a webpage, it runs entirely in your browser, so no install is required. All processing happens locally, meaning that no data leaves your machine/system.

Demo available from [webdata.nb.no/warc-explorer](https://webdata.nb.no/warc-explorer).

![Screenshot of WARC Explorer](/docs/warc-explorer-screenshot.png)

## Requirements
- Your favorite web browser
- A WARC file
    - (If you do not have your own WARC files, [download one of ours](https://github.com/NationalLibraryOfNorway/webdata-warc-explorer/tree/main/warcs) for testing.

## Getting started

### Download source code:
- Download the [latest release](https://github.com/NationalLibraryOfNorway/webdata-warc-explorer/releases/latest)
- Unzip the file

### Start the application:
- Navigate to the **app** folder
- Open **index.html** in your browser



## Usage
The interface is devided in three vertically separated areas: 
- The left pane let you choose a folder containing WARC files, and mark a WARC file for exploration.
- The centre pane displays a list of records contained with the file. On the top, there are also features for searching and filtering the records.
- The right pane displays the chosen record's WARC Header, HTTP Header and WARC Content (HTTP payload). The payload can also be opened in a new tab in your browser, allowing closer exploration of text, image, audio, video and code resources.

You also need one or more WARC files to explore. If you do not have your own, try with one 

The interface is designed to be simple, fast and intuitive. Still, for anyone who are new to WARC files, there will be many new concepts.
If you find yourself lost, try to follow the guide to get started.

### Choose folder / file to explore
Press the "Choose folder" button in the upper left to choose a folder with WARC files.
This will display all .warc / .warc.gz in the left pane.

Choosing one of these WARC files will then display all WARC records contained in that file in the centre pane.

### Filtering / searching records
Records in the centre pane can be filtered by their `WARC-Type`.

You can also search in for specific domain-names, record-IDs or even file extensions if these are part of the `WARC-Target-URI` field.

### Inspect WARC Header, HTTP Header and HTTP payload
To inspect the headers and content of a resource, choose it from the centre pane. This will load the WARC Header, HTTP Header and HTTP payload in the pane to the right.

All records with an HTTP payload ca be opened in a new tab in your browser, allowing you to represent it as a web resource.

## Feedback
Please report bugs or problems by committing an issue, describing:
- what you do,
- what you expect to happen,
- what actually happens.

Please, add some contextual information about the WARC file and your browser version. If you know how to fix the problem, feel free to commit a pull requests related to the issue.

We also appreciate feedback and user-stories, which can be sent to webdata@nb.no.

## Credits
WARC parsing is done with a bundled version of Webrecorder's [warcio.js](https://github.com/webrecorder/warcio.js).

WARC Explorer is inspired by:
- common file explorer interfaces,
- [Warchaeology](https://github.com/NationalLibraryOfNorway/warchaeology)'s CLI console,
- [Johanna Drucker's critical studies of interfaces](https://doi.org/10.63744/d9h2c6cvq8jc) for humanistic research.

The web application builds on a previous [prototype for a python-based desktop application](https://github.com/joncto/warc-explorer-desktop).
