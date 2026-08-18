# WARC Explorer
A tiny application for client-side exploration of WARC files and records in a browser.

Built as a webpage, the app runs entirely in your browser, so no installation is required.

All processing happens locally, meaning that no data leaves your machine/system.

Demo available from [webdata.nb.no/warc-explorer/](https://webdata.nb.no/warc-explorer/).

![Screenshot of WARC Explorer](/docs/warc-explorer-screenshot.png)

## Requirements
- A web browser
- A WARC file
    - (If you do not have a WARC file, [download one of ours](https://github.com/NationalLibraryOfNorway/webdata-warc-explorer/tree/main/warcs) for testing.

## Getting started

### Download source code:
- Download the [latest release](https://github.com/NationalLibraryOfNorway/webdata-warc-explorer/releases/latest)
- Unzip the file

### Start the application:
- Navigate to the **app** folder
- Open **index.html** in your browser

## Usage
WARC Explorer is designed for exploration of WARC files, without requiring any prior knowledge of the WARC format and its specification.

The interface is devided in three vertically separated areas: 
- The left pane is a file explorer that let you open a folder with WARC files and choose a file to explore.
- The centre pane display a list of records contained within the file. On the top, there are features for searching and filtering the records.
- The right pane displays the chosen record's WARC Header, HTTP Header and WARC Content (HTTP payload). The payload can also be opened in a new tab in your browser, allowing closer exploration of text, image, audio, video and code resources.

If you find yourself lost, try to follow the guide below.

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

### Linking to remotely hosted WARC files
Remote WARC URLs can be supplied as repeated `warc` parameters in the page URL fragment:

```text
index.html#warc=https://example.com/one.warc.gz&warc=https://example.com/two.warc.gz
```

The remote server must allow cross-origin requests and HTTP byte-range requests.

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
- Common file explorer interfaces like Finder/Windows Explorer,
- [Warchaeology](https://github.com/NationalLibraryOfNorway/warchaeology)'s CLI console,
- A python-based prototype for a [desktop application](https://github.com/joncto/warc-explorer-desktop).
- [Johanna Drucker's critical studies of interfaces](https://doi.org/10.63744/d9h2c6cvq8jc) for humanistic research.
