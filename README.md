# WARC Explorer
A tiny client-side web application for exploring WARC files and records in a browser.

Usage does not require installation. All processing happens locally, so that no data leaves your machine.

![Screenshot of WARC Explorer](/docs/warc-explorer-screenshot.png)

## Getting started
Download source code:
- Download the [latest release](https://github.com/joncto/warc-explorer/releases/latest).
- Unzip the file

To start the application:
- Open the **app** folder,
- Open **index.html** in your browser.

## Usage
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

## Credits
WARC parsing is done with a bundled version of Webrecorder's [warcio.js](https://github.com/webrecorder/warcio.js).

The layout is inspired by common file explorer interfaces and [Warchaeology](https://github.com/NationalLibraryOfNorway/warchaeology)'s CLI console.
