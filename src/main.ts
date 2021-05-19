import { App, Plugin } from "obsidian";
import { MarkdownPostProcessorContext, MarkdownView, Editor } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import { render, renderErrorMessage } from "./rendering";
import { getRenderInfoFromYaml } from "./parsing";
import {
    NullableNumber,
    Datasets,
    Query,
    QueryValuePair,
    OutputType,
    SearchType,
    TableData,
} from "./data";
import {
    TrackerSettings,
    DEFAULT_SETTINGS,
    TrackerSettingTab,
} from "./settings";
import * as helper from "./helper";
import { Moment } from "moment";
// import { getDailyNoteSettings } from "obsidian-daily-notes-interface";

declare global {
    interface Window {
        app: App;
        moment: () => Moment;
    }
}

let timeFormat = [
    "HH:mm",
    "HH:m",
    "H:mm",
    "H:m",
    "hh:mm A",
    "hh:mm a",
    "hh:m A",
    "hh:m a",
    "h:mm A",
    "h:mm a",
    "h:m A",
    "h:m a",
];

export default class Tracker extends Plugin {
    settings: TrackerSettings;

    async onload() {
        console.log("loading obsidian-tracker plugin");

        await this.loadSettings();

        this.addSettingTab(new TrackerSettingTab(this.app, this));

        this.registerMarkdownCodeBlockProcessor(
            "tracker",
            this.postprocessor.bind(this)
        );

        this.addCommand({
            id: "add-line-chart-tracker",
            name: "Add Line Chart Tracker",
            callback: () => this.addCodeBlock(OutputType.Line),
        });

        this.addCommand({
            id: "add-bar-chart-tracker",
            name: "Add Bar Chart Tracker",
            callback: () => this.addCodeBlock(OutputType.Bar),
        });

        this.addCommand({
            id: "add-summary-tracker",
            name: "Add Summary Tracker",
            callback: () => this.addCodeBlock(OutputType.Summary),
        });
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    onunload() {
        console.log("unloading obsidian-tracker plugin");
    }

    getFilesInFolder(
        folder: TFolder,
        includeSubFolders: boolean = true
    ): TFile[] {
        let files: TFile[] = [];

        for (let item of folder.children) {
            if (item instanceof TFile) {
                if (item.extension === "md") {
                    files.push(item);
                }
            } else {
                if (item instanceof TFolder && includeSubFolders) {
                    files = files.concat(this.getFilesInFolder(item));
                }
            }
        }

        return files;
    }

    getFiles(folderToSearch: string, includeSubFolders: boolean = true) {
        let files: TFile[] = [];

        let folder = this.app.vault.getAbstractFileByPath(
            normalizePath(folderToSearch)
        );
        if (!folder || !(folder instanceof TFolder)) {
            // Folder not exists
        } else {
            files = files.concat(this.getFilesInFolder(folder));
        }

        return files;
    }

    addToDataMap(
        dataMap: Map<string, Array<QueryValuePair>>,
        date: string,
        query: Query,
        value: NullableNumber
    ) {
        if (!dataMap.has(date)) {
            let queryValuePairs = new Array<QueryValuePair>();
            queryValuePairs.push({ query: query, value: value });
            dataMap.set(date, queryValuePairs);
        } else {
            let targetValuePairs = dataMap.get(date);
            targetValuePairs.push({ query: query, value: value });
        }
    }

    async postprocessor(
        source: string,
        el: HTMLElement,
        ctx: MarkdownPostProcessorContext
    ) {
        // console.log("postprocess");
        const canvas = document.createElement("div");

        let yamlText = source.trim();
        let renderInfo = getRenderInfoFromYaml(yamlText, this);
        if (typeof renderInfo === "string") {
            let errorMessage = renderInfo;
            renderErrorMessage(canvas, errorMessage);
            el.appendChild(canvas);
            return;
        }
        // console.log(renderInfo);

        // Get files
        let files: TFile[];
        try {
            files = this.getFiles(renderInfo.folder);
        } catch (e) {
            let errorMessage = e.message;
            renderErrorMessage(canvas, errorMessage);
            el.appendChild(canvas);
            return;
        }
        // console.log(files);

        // let dailyNotesSettings = getDailyNoteSettings();
        // console.log(dailyNotesSettings);
        // I always got YYYY-MM-DD from dailyNotesSettings.format
        // Use own settings panel for now

        // Collecting data to dataMap first
        let minDate = window.moment("");
        let maxDate = window.moment("");
        let fileCounter = 0;

        
        let dataMap = new Map<string, Array<QueryValuePair>>(); // {strDate: [query: value, ...]}
        // Collect data from files in date range
        for (let file of files) {
            
            // Get fileCache and content
            let fileCache = null;
            let needFileCache = renderInfo.queries.some((q) => {
                let type = q.getType();
                if (type === SearchType.Frontmatter || type === SearchType.Tag || type === SearchType.Wiki) {
                    return true;
                }
                return false;
            });
            if (needFileCache) {
                fileCache = this.app.metadataCache.getFileCache(file);
            }

            let content = null;
            let needContent = renderInfo.queries.some((q) => {
                let type = q.getType();
                if (type === SearchType.Tag || type === SearchType.Text || type === SearchType.dvField) {
                    return true;
                }
                return false;
            });
            if (needContent) {
                content = await this.app.vault.adapter.read(file.path);
            }

            // Loop over queries
            for (let query of renderInfo.queries) {
                if (query.getType() === SearchType.Table) continue;

                let fileBaseName = file.basename;

                if (
                    renderInfo.dateFormatPrefix &&
                    fileBaseName.startsWith(renderInfo.dateFormatPrefix)
                ) {
                    fileBaseName = fileBaseName.slice(
                        renderInfo.dateFormatPrefix.length
                    );
                }
                if (
                    renderInfo.dateFormatSuffix &&
                    fileBaseName.endsWith(renderInfo.dateFormatSuffix)
                ) {
                    fileBaseName = fileBaseName.slice(
                        0,
                        fileBaseName.length - renderInfo.dateFormatSuffix.length
                    );
                }
                // console.log(fileBaseName);

                let fileDate = window.moment(
                    fileBaseName,
                    renderInfo.dateFormat,
                    true
                );
                // console.log(fileDate);
                // TODO: should exclude files out of date range
                if (!fileDate.isValid()) {
                    // console.log("file " + fileBaseName + " rejected");
                    continue;
                } else {
                    // console.log("file " + fileBaseName + " accepted");
                    if (renderInfo.startDate !== null) {
                        if (fileDate < renderInfo.startDate) {
                            continue;
                        }
                    }
                    if (renderInfo.endDate !== null) {
                        if (fileDate > renderInfo.endDate) {
                            continue;
                        }
                    }
                    fileCounter++;
                }
                // console.log(query);
                // console.log(fileBaseName);

                // Get min/max date
                if (fileCounter == 1) {
                    minDate = fileDate.clone();
                    maxDate = fileDate.clone();
                } else {
                    if (fileDate < minDate) {
                        minDate = fileDate.clone();
                    }
                    if (fileDate > maxDate) {
                        maxDate = fileDate.clone();
                    }
                }

                // rules for assigning tag value
                // simple tag
                //   tag exists --> constant value
                //   tag not exists --> null
                // valued-attached tag
                //   tag exists
                //     with value --> that value
                //     without value --> null
                //   tag not exists --> null

                // console.log("Search frontmatter tags");
                if (fileCache && query.getType() === SearchType.Tag) {
                    // Add frontmatter tags, allow simple tag only
                    let frontMatter = fileCache.frontmatter;
                    let frontMatterTags: string[] = [];
                    if (frontMatter && frontMatter.tags) {
                        // console.log(frontMatter.tags);
                        let tagMeasure = 0.0;
                        let tagExist = false;
                        if (Array.isArray(frontMatter.tags)) {
                            frontMatterTags = frontMatterTags.concat(
                                frontMatter.tags
                            );
                        } else {
                            frontMatterTags.push(frontMatter.tags);
                        }

                        for (let tag of frontMatterTags) {
                            if (tag === query.getTarget()) {
                                // simple tag
                                tagMeasure =
                                    tagMeasure +
                                    renderInfo.constValue[query.getId()];
                                tagExist = true;
                            } else if (
                                tag.startsWith(query.getTarget() + "/")
                            ) {
                                // nested tag
                                tagMeasure =
                                    tagMeasure +
                                    renderInfo.constValue[query.getId()];
                                tagExist = true;
                            } else {
                                continue;
                            }

                            // valued-tag in frontmatter is not supported
                            // because the "tag:value" in frontmatter will be consider as a new tag for different values

                            let value = null;
                            if (tagExist) {
                                value = tagMeasure;
                            }
                            this.addToDataMap(
                                dataMap,
                                fileDate.format(renderInfo.dateFormat),
                                query,
                                value
                            );
                        }
                    }
                } // Search frontmatter tags

                // console.log("Search frontmatter keys");
                if (
                    fileCache &&
                    query.getType() === SearchType.Frontmatter &&
                    query.getTarget() !== "tags"
                ) {
                    let frontMatter = fileCache.frontmatter;
                    if (frontMatter) {
                        if (frontMatter[query.getTarget()]) {
                            // console.log("single value");
                            // console.log(frontMatter[query.getTarget()]);
                            let value = null;
                            let toParse = frontMatter[query.getTarget()];
                            if (typeof toParse === "string") {
                                if (toParse.includes(":")) {
                                    // time value
                                    let timeValue = window.moment(
                                        toParse,
                                        timeFormat,
                                        true
                                    );
                                    if (timeValue.isValid()) {
                                        query.setUsingTimeValue();
                                        value = timeValue.diff(
                                            window.moment(
                                                "00:00",
                                                "HH:mm",
                                                true
                                            ),
                                            "seconds"
                                        );
                                    }
                                } else {
                                    value = parseFloat(toParse);
                                }
                            } else {
                                value = parseFloat(toParse);
                            }
                            if (Number.isNumber(value)) {
                                this.addToDataMap(
                                    dataMap,
                                    fileDate.format(renderInfo.dateFormat),
                                    query,
                                    value
                                );
                            }
                        } else if (
                            query.getParentTarget() &&
                            frontMatter[query.getParentTarget()]
                        ) {
                            // console.log("multiple values");
                            // console.log(query.getTarget());
                            // console.log(query.getParentTarget());
                            // console.log(query.getSubId());
                            // console.log(
                            //     frontMatter[query.getParentTarget()]
                            // );
                            let toParse =
                                frontMatter[query.getParentTarget()];
                            let splitted = null;
                            if (Array.isArray(toParse)) {
                                splitted = toParse.map((p) => {
                                    return p.toString();
                                });
                            } else if (typeof toParse === "string") {
                                if (toParse.includes(",")) {
                                    splitted = toParse.split(",");
                                } else {
                                    splitted = toParse.split(
                                        query.getSeparator()
                                    );
                                }
                            }
                            if (
                                splitted &&
                                splitted.length > query.getAccessor() &&
                                query.getAccessor() >= 0
                            ) {
                                // TODO: it's not efficent to retrieve one value at a time, enhance this
                                let value = null;
                                let splittedPart =
                                    splitted[query.getAccessor()].trim();
                                if (toParse.includes(":")) {
                                    // time value
                                    let timeValue = window.moment(
                                        splittedPart,
                                        timeFormat,
                                        true
                                    );
                                    if (timeValue.isValid()) {
                                        query.setUsingTimeValue();
                                        value = timeValue.diff(
                                            window.moment(
                                                "00:00",
                                                "HH:mm",
                                                true
                                            ),
                                            "seconds"
                                        );
                                    }
                                } else {
                                    value = parseFloat(splittedPart);
                                }

                                if (Number.isNumber(value)) {
                                    this.addToDataMap(
                                        dataMap,
                                        fileDate.format(
                                            renderInfo.dateFormat
                                        ),
                                        query,
                                        value
                                    );
                                }
                            }
                        }
                    }
                } // console.log("Search frontmatter keys");

                // console.log("Search wiki links");
                if (fileCache && query.getType() === SearchType.Wiki) {
                    let links = fileCache.links;

                    let linkMeasure = 0.0;
                    let linkExist = false;
                    for (let link of links) {
                        if (link.link === query.getTarget()) {
                            linkExist = true;
                            linkMeasure =
                                linkMeasure +
                                renderInfo.constValue[query.getId()];
                        }
                    }

                    let linkValue = null;
                    if (linkExist) {
                        linkValue = linkMeasure;
                    }
                    this.addToDataMap(
                        dataMap,
                        fileDate.format(renderInfo.dateFormat),
                        query,
                        linkValue
                    );
                }

                // console.log("Search inline tags");
                if (content && query.getType() === SearchType.Tag) {
                    // console.log(content);
                    // Test this in Regex101
                    // (^|\s)#tagName(\/[\w-]+)*(:(?<values>[\d\.\/-]*)[a-zA-Z]*)?([\\.!,\\?;~-]*)?(\s|$)
                    let tagName = query.getTarget();
                    if (query.getParentTarget()) {
                        tagName = query.getParentTarget(); // use parent tag name for multiple values
                    }
                    let strHashtagRegex =
                        "(^|\\s)#" +
                        tagName +
                        "(\\/[\\w-]+)*(:(?<values>[\\d\\.\\/-]*)[a-zA-Z]*)?([\\.!,\\?;~-]*)?(\\s|$)";
                    // console.log(strHashtagRegex);
                    let hashTagRegex = new RegExp(strHashtagRegex, "gm");
                    let match;
                    let tagMeasure = 0.0;
                    let tagExist = false;
                    while ((match = hashTagRegex.exec(content))) {
                        // console.log(match);
                        if (
                            !renderInfo.ignoreAttachedValue[query.getId()] &&
                            typeof match.groups !== "undefined" &&
                            typeof match.groups.values !== "undefined"
                        ) {
                            // console.log("value-attached tag");
                            let values = match.groups.values;
                            let splitted = null;
                            if (values.includes(",")) {
                                splitted = values.split(",");
                            } else {
                                splitted = match.groups.values.split(
                                    query.getSeparator()
                                );
                            }
                            if (!splitted) continue;
                            if (splitted.length === 1) {
                                // console.log("single-value");
                                let toParse = match.groups.values.trim();
                                if (toParse.includes(":")) {
                                    let timeValue = window.moment(
                                        toParse,
                                        timeFormat,
                                        true
                                    );
                                    if (timeValue.isValid()) {
                                        query.setUsingTimeValue();
                                        tagMeasure = timeValue.diff(
                                            window.moment(
                                                "00:00",
                                                "HH:mm",
                                                true
                                            ),
                                            "seconds"
                                        );
                                        tagExist = true;
                                    }
                                } else {
                                    let value = parseFloat(toParse);
                                    // console.log(value);
                                    if (!Number.isNaN(value)) {
                                        if (
                                            !renderInfo.ignoreZeroValue[
                                                query.getId()
                                            ] ||
                                            value !== 0
                                        ) {
                                            tagMeasure += value;
                                            tagExist = true;
                                        }
                                    }
                                }
                            } else if (
                                splitted.length > query.getAccessor() &&
                                query.getAccessor() >= 0
                            ) {
                                // TODO: it's not efficent to retrieve one value at a time, enhance this
                                // console.log("multiple-values");
                                let toParse =
                                    splitted[query.getAccessor()].trim();
                                if (toParse.includes(":")) {
                                    let timeValue = window.moment(
                                        toParse,
                                        timeFormat,
                                        true
                                    );
                                    if (timeValue.isValid()) {
                                        query.setUsingTimeValue();
                                        tagMeasure = timeValue.diff(
                                            window.moment(
                                                "00:00",
                                                "HH:mm",
                                                true
                                            ),
                                            "seconds"
                                        );
                                        tagExist = true;
                                    }
                                } else {
                                    let value = parseFloat(toParse);
                                    if (Number.isNumber(value)) {
                                        tagMeasure += value;
                                        tagExist = true;
                                    }
                                }
                            }
                        } else {
                            // console.log("simple-tag");
                            tagMeasure =
                                tagMeasure +
                                renderInfo.constValue[query.getId()];
                            tagExist = true;
                        }
                    }

                    let value = null;
                    if (tagExist) {
                        value = tagMeasure;
                    }
                    this.addToDataMap(
                        dataMap,
                        fileDate.format(renderInfo.dateFormat),
                        query,
                        value
                    );
                } // Search inline tags

                // console.log("Search text");
                if (content && query.getType() === SearchType.Text) {
                    let strTextRegex = query.getTarget();
                    // console.log(strTextRegex);
                    let textRegex = new RegExp(strTextRegex, "gm");
                    let match;
                    let textMeasure = 0.0;
                    let textExist = false;
                    while ((match = textRegex.exec(content))) {
                        // console.log(match);
                        if (
                            !renderInfo.ignoreAttachedValue[query.getId()] &&
                            typeof match.groups !== "undefined"
                        ) {
                            // match[0] whole match
                            // console.log("valued-text");
                            if (typeof match.groups.value !== "undefined") {
                                // set as null for missing value if it is valued-tag
                                let value = parseFloat(match.groups.value);
                                // console.log(value);
                                if (!Number.isNaN(value)) {
                                    if (
                                        !renderInfo.ignoreZeroValue[
                                            query.getId()
                                        ] ||
                                        value !== 0
                                    ) {
                                        textMeasure += value;
                                        textExist = true;
                                    }
                                }
                            }
                        } else {
                            // console.log("simple-text");
                            textMeasure =
                                textMeasure +
                                renderInfo.constValue[query.getId()];
                            textExist = true;
                        }
                    }

                    if (textExist) {
                        this.addToDataMap(
                            dataMap,
                            fileDate.format(renderInfo.dateFormat),
                            query,
                            textMeasure
                        );
                    }
                } // Search text

                // console.log("Search dvField");
                if (content && query.getType() === SearchType.dvField) {
                    // Test this in Regex101
                    // (^|\s)\*{0,2}dvTarget\*{0,2}(::\s*(?<values>[\d\.\/\-\w,@;\s]*))(\s|$)
                    let dvTarget = query.getTarget();
                    if (query.getParentTarget()) {
                        dvTarget = query.getParentTarget(); // use parent tag name for multiple values
                    }
                    let strHashtagRegex =
                        "(^|\\s)\\*{0,2}" +
                        dvTarget +
                        "\\*{0,2}(::\\s*(?<values>[\\d\\.\\/\\-\\w,@;\\s]*))(\\s|$)";
                    // console.log(strHashtagRegex);
                    let hashTagRegex = new RegExp(strHashtagRegex, "gm");
                    let match;
                    let tagMeasure = 0.0;
                    let tagExist = false;
                    while ((match = hashTagRegex.exec(content))) {
                        // console.log(match);
                        if (
                            typeof match.groups !== "undefined" &&
                            typeof match.groups.values !== "undefined"
                        ) {
                            let values = match.groups.values.trim();
                            let splitted = null;
                            if (values.includes(",")) {
                                splitted = values.split(",");
                            } else {
                                splitted = values.split(query.getSeparator());
                            }
                            if (!splitted) continue;
                            if (splitted.length === 1) {
                                // console.log("single-value");
                                let toParse = splitted[0];
                                if (toParse.includes(":")) {
                                    let timeValue = window.moment(
                                        toParse,
                                        timeFormat,
                                        true
                                    );
                                    if (timeValue.isValid()) {
                                        query.setUsingTimeValue();
                                        tagMeasure = timeValue.diff(
                                            window.moment(
                                                "00:00",
                                                "HH:mm",
                                                true
                                            ),
                                            "seconds"
                                        );
                                        tagExist = true;
                                    }
                                } else {
                                    let value = parseFloat(toParse);
                                    // console.log(value);
                                    if (!Number.isNaN(value)) {
                                        if (
                                            !renderInfo.ignoreZeroValue[
                                                query.getId()
                                            ] ||
                                            value !== 0
                                        ) {
                                            tagMeasure += value;
                                            tagExist = true;
                                        }
                                    }
                                }
                            } else if (
                                splitted.length > query.getAccessor() &&
                                query.getAccessor() >= 0
                            ) {
                                // TODO: it's not efficent to retrieve one value at a time, enhance this
                                // console.log("multiple-values");
                                let toParse =
                                    splitted[query.getAccessor()].trim();
                                if (toParse.includes(":")) {
                                    let timeValue = window.moment(
                                        toParse,
                                        timeFormat,
                                        true
                                    );
                                    if (timeValue.isValid()) {
                                        query.setUsingTimeValue();
                                        tagMeasure = timeValue.diff(
                                            window.moment(
                                                "00:00",
                                                "HH:mm",
                                                true
                                            ),
                                            "seconds"
                                        );
                                        tagExist = true;
                                    }
                                } else {
                                    let value = parseFloat(toParse);
                                    if (Number.isNumber(value)) {
                                        tagMeasure += value;
                                        tagExist = true;
                                    }
                                }
                            }
                        } else {
                            // console.log("simple-tag");
                            tagMeasure =
                                tagMeasure +
                                renderInfo.constValue[query.getId()];
                            tagExist = true;
                        }
                    }

                    let value = null;
                    if (tagExist) {
                        value = tagMeasure;
                    }
                    this.addToDataMap(
                        dataMap,
                        fileDate.format(renderInfo.dateFormat),
                        query,
                        value
                    );
                } // search dvField
            } // end loof of files
        }

        // Collect data from files assigned in searchTargets
        let tableQueries = renderInfo.queries.filter(
            (q) => q.getType() === SearchType.Table
        );
        // Separate queries by tables and xDatasets/yDatasets
        let tables: Array<TableData> = [];
        for (let query of tableQueries) {
            let filePath = query.getParentTarget();
            let tableIndex = query.getAccessor();
            let isX = query.usedAsXDataset;

            let table = tables.find(
                (t) => t.filePath === filePath && t.tableIndex === tableIndex
            );
            if (table) {
                if (isX) {
                    table.xDataset = query;
                } else {
                    table.yDatasets.push(query);
                }
            } else {
                let tableData = new TableData(filePath, tableIndex);
                if (isX) {
                    tableData.xDataset = query;
                } else {
                    tableData.yDatasets.push(query);
                }
                tables.push(tableData);
            }
        }
        // console.log(tables);

        for (let tableData of tables) {
            //extract xDataset from query
            let xDatasetQuery = tableData.xDataset;
            let yDatasetQueries = tableData.yDatasets;
            let filePath = xDatasetQuery.getParentTarget();
            let tableIndex = xDatasetQuery.getAccessor();

            // Get table text
            let textTable = "";
            filePath = filePath + ".md";
            let file = this.app.vault.getAbstractFileByPath(
                normalizePath(filePath)
            );
            if (file && file instanceof TFile) {
                fileCounter++;
                let content = await this.app.vault.adapter.read(file.path);
                // console.log(content);

                // Test this in Regex101
                // This is a not-so-strict table selector
                // ((\r?\n){2}|^)([^\r\n]*\|[^\r\n]*(\r?\n)?)+(?=(\r?\n){2}|$)
                let strMDTableRegex =
                    "((\\r?\\n){2}|^)([^\\r\\n]*\\|[^\\r\\n]*(\\r?\\n)?)+(?=(\\r?\\n){2}|$)";
                // console.log(strMDTableRegex);
                let mdTableRegex = new RegExp(strMDTableRegex, "gm");
                let match;
                let indTable = 0;

                while ((match = mdTableRegex.exec(content))) {
                    // console.log(match);
                    if (indTable === tableIndex) {
                        textTable = match[0];
                        break;
                    }
                    indTable++;
                }
            } else {
                // file not exists
                continue;
            }
            // console.log(textTable);

            let tableLines = textTable.split(/\r?\n/);
            tableLines = tableLines.filter((line) => {
                return line !== "";
            });
            let numColumns = 0;
            let numDataRows = 0;
            // console.log(tableLines);

            // Make sure it is a valid table first
            if (tableLines.length >= 2) {
                // Must have header and separator line
                let headerLine = tableLines.shift().trim();
                headerLine = helper.trimByChar(headerLine, "|");
                let headerSplitted = headerLine.split("|");
                numColumns = headerSplitted.length;

                let sepLine = tableLines.shift().trim();
                sepLine = helper.trimByChar(sepLine, "|");
                let spepLineSplitted = sepLine.split("|");
                for (let col of spepLineSplitted) {
                    if (!col.includes("-")) {
                        break; // Not a valid sep
                    }
                }

                numDataRows = tableLines.length;
            }

            if (numDataRows == 0) continue;

            // get x data
            let columnXDataset = xDatasetQuery.getAccessor(1);
            if (columnXDataset >= numColumns) continue;
            let xValues = [];

            for (let tableLine of tableLines) {
                let dataRow = helper.trimByChar(tableLine.trim(), "|");
                let dataRowSplitted = dataRow.split("|");
                if (columnXDataset < dataRowSplitted.length) {
                    let data = dataRowSplitted[columnXDataset].trim();

                    let date = window.moment(data, renderInfo.dateFormat, true);

                    if (!minDate.isValid() && !maxDate.isValid()) {
                        minDate = date.clone();
                        maxDate = date.clone();
                    } else {
                        if (date < minDate) {
                            minDate = date.clone();
                        }
                        if (date > maxDate) {
                            maxDate = date.clone();
                        }
                    }

                    xValues.push(date);
                }
            }
            // console.log(xValues);

            // get y data
            for (let yDatasetQuery of yDatasetQueries) {
                let columnOfInterest = yDatasetQuery.getAccessor(1);
                // console.log(`columnOfInterest: ${columnOfInterest}, numColumns: ${numColumns}`);
                if (columnOfInterest >= numColumns) continue;

                let indLine = 0;
                for (let tableLine of tableLines) {
                    let dataRow = helper.trimByChar(tableLine.trim(), "|");
                    let dataRowSplitted = dataRow.split("|");
                    if (columnOfInterest < dataRowSplitted.length) {
                        let data = dataRowSplitted[columnOfInterest].trim();
                        let splitted = null;
                        if (data.includes(",")) {
                            splitted = data.split(",");
                        } else {
                            splitted = data.split(yDatasetQuery.getSeparator());
                        }
                        if (!splitted) continue;
                        if (splitted.length === 1) {
                            let value = parseFloat(splitted[0]);
                            if (Number.isNumber(value)) {
                                this.addToDataMap(
                                    dataMap,
                                    xValues[indLine].format(
                                        renderInfo.dateFormat
                                    ),
                                    yDatasetQuery,
                                    value
                                );
                            }
                        } else if (
                            splitted.length > yDatasetQuery.getAccessor(2) &&
                            yDatasetQuery.getAccessor(2) >= 0
                        ) {
                            let value = null;
                            let splittedPart =
                                splitted[yDatasetQuery.getAccessor(2)].trim();
                            value = parseFloat(splittedPart);
                            if (Number.isNumber(value)) {
                                this.addToDataMap(
                                    dataMap,
                                    xValues[indLine].format(
                                        renderInfo.dateFormat
                                    ),
                                    yDatasetQuery,
                                    value
                                );
                            }
                        }
                    }

                    indLine++;
                } // Loop over tableLines
            }
        }

        if (fileCounter === 0) {
            let errorMessage = "No notes found in the date range.";
            renderErrorMessage(canvas, errorMessage);
            el.appendChild(canvas);
            return;
        }
        // console.log(minDate);
        // console.log(maxDate);
        // console.log(dataMap);

        // Check date range
        if (!minDate.isValid() || !maxDate.isValid()) {
            let errorMessage = "Invalid date range";
            renderErrorMessage(canvas, errorMessage);
            el.appendChild(canvas);
            return;
        }
        if (renderInfo.startDate === null && renderInfo.endDate === null) {
            // No date arguments
            renderInfo.startDate = minDate.clone();
            renderInfo.endDate = maxDate.clone();
        } else if (
            renderInfo.startDate !== null &&
            renderInfo.endDate === null
        ) {
            if (renderInfo.startDate < maxDate) {
                renderInfo.endDate = maxDate.clone();
            } else {
                let errorMessage = "Invalid date range";
                renderErrorMessage(canvas, errorMessage);
                el.appendChild(canvas);
                return;
            }
        } else if (
            renderInfo.endDate !== null &&
            renderInfo.startDate === null
        ) {
            if (renderInfo.endDate > minDate) {
                renderInfo.startDate = minDate.clone();
            } else {
                let errorMessage = "Invalid date range";
                renderErrorMessage(canvas, errorMessage);
                el.appendChild(canvas);
                return;
            }
        } else {
            // startDate and endDate are valid
            if (
                (renderInfo.startDate < minDate &&
                    renderInfo.endDate < minDate) ||
                (renderInfo.startDate > maxDate && renderInfo.endDate > maxDate)
            ) {
                let errorMessage = "Invalid date range";
                renderErrorMessage(canvas, errorMessage);
                el.appendChild(canvas);
                return;
            }
        }
        // console.log(renderInfo.startDate);
        // console.log(renderInfo.endDate);

        // Reshape data for rendering
        let datasets = new Datasets(renderInfo.startDate, renderInfo.endDate);
        for (let query of renderInfo.queries) {
            let dataset = datasets.createDataset(query, renderInfo);
            for (
                let curDate = renderInfo.startDate.clone();
                curDate <= renderInfo.endDate;
                curDate.add(1, "days")
            ) {
                // console.log(curDate);

                // dataMap --> {date: [query: value, ...]}
                if (dataMap.has(curDate.format(renderInfo.dateFormat))) {
                    let queryValuePairs = dataMap
                        .get(curDate.format(renderInfo.dateFormat))
                        .filter(function (pair) {
                            return pair.query.equalTo(query);
                        });
                    if (queryValuePairs.length > 0) {
                        // Merge values of the same day same query
                        let pair = queryValuePairs[0];
                        let value = 0;
                        let hasValue = false;
                        for (
                            let indPair = 0;
                            indPair < queryValuePairs.length;
                            indPair++
                        ) {
                            if (queryValuePairs[indPair].value !== null) {
                                value += queryValuePairs[indPair].value;
                                hasValue = true;
                            }
                        }
                        // console.log(hasValue);
                        // console.log(value);
                        if (hasValue) {
                            dataset.setValue(curDate, value);
                        }
                    }
                }
            }
        }
        renderInfo.datasets = datasets;
        // console.log(renderInfo.datasets);

        let result = render(canvas, renderInfo);
        if (typeof result === "string") {
            let errorMessage = result;
            renderErrorMessage(canvas, errorMessage);
            el.appendChild(canvas);
            return;
        }

        el.appendChild(canvas);
    }

    getEditor(): Editor {
        return this.app.workspace.getActiveViewOfType(MarkdownView).editor;
    }

    addCodeBlock(outputType: OutputType): void {
        const currentView = this.app.workspace.activeLeaf.view;

        if (!(currentView instanceof MarkdownView)) {
            return;
        }

        let codeblockToInsert = "";
        switch (outputType) {
            case OutputType.Line:
                codeblockToInsert = `\`\`\` tracker
searchType: tag
searchTarget: tagName
folder: /
startDate:
endDate:
line:
    title: "Line Chart"
    xAxisLabel: Date
    yAxisLabel: Value
\`\`\``;
                break;
            case OutputType.Bar:
                codeblockToInsert = `\`\`\` tracker
searchType: tag
searchTarget: tagName
folder: /
startDate:
endDate:
bar:
    title: "Bar Chart"
    xAxisLabel: Date
    yAxisLabel: Value
\`\`\``;
                break;
            case OutputType.Summary:
                codeblockToInsert = `\`\`\` tracker
searchType: tag
searchTarget: tagName
folder: /
startDate:
endDate:
summary:
    template: "Average value of tagName is {{average}}"
    style: "color:white;"
\`\`\``;
                break;
            default:
                break;
        }

        if (codeblockToInsert !== "") {
            let textInserted = this.insertToNextLine(codeblockToInsert);
            if (!textInserted) {
            }
        }
    }

    insertToNextLine(text: string): boolean {
        let editor = this.getEditor();

        if (editor) {
            let cursor = editor.getCursor();
            let lineNumber = cursor.line;
            let line = editor.getLine(lineNumber);

            cursor.ch = line.length;
            editor.setSelection(cursor);
            editor.replaceSelection("\n" + text);

            return true;
        }

        return false;
    }
}
