import * as React from "react";
import * as ReactDOM from "react-dom";
import * as Immutable from "immutable";
import {escapeCssValue, split2, splitPathAndUnescape, replaceValuePath, immutableMap}
from "./common";

function pruneOldAux(maxEpoch: number, value: any): any {
    if (!value) {
	return null;
    } else if (typeof value.epoch != "undefined") { // fixme: ugly type check
	if (maxEpoch >= value.epoch) return null;
	return value;
    } else {
	if (!value.asImmutable) throw "bad type?";
	return immutableMap(value, (v: any) => pruneOldAux(maxEpoch, v));
    }
}

class PendingValue {
    path: Array<string>
    value: any
    doSet: ((x: any) => void);
    doSetPath: ((path: Array<string>, value: any) => void);
    doActionPath: ((path: Array<string>, value: any) => void);

    constructor(path: Array<string>, value: any,
		doSetPath: ((path: Array<string>, value: any) => void),
		doActionPath: ((path: Array<string>, value: any) => void)) {
	this.path = path;
	this.value = value;
	this.doSet = (x) => {
	    doSetPath(this.path, x);
	};
	this.doActionPath = doActionPath;
	this.doSetPath = doSetPath;
    }

    pruneOld(maxEpoch: number) {
	return new PendingValue(this.path, pruneOldAux(maxEpoch, this.value), this.doSetPath, this.doActionPath);
    }

    getValue(defaultValue: any) {
	if (!this.value) return defaultValue;
	return this.value.value;
    }

    action(msg: any) {
	this.doActionPath(this.path, msg);
    }

    sub(name: string): PendingValue {
	if (this.value && !this.value.asImmutable) throw "this pending value has no subvalues";
	return new PendingValue(this.path.concat(name), this.value ? this.value.get(name) : null, this.doSetPath, this.doActionPath);
    }
}

type BookUpdateFunc = ((f: ((book: BookState) => BookState)) => void);

class BookState {
    editable: boolean
    widgetData: Map<string, any>
    widgetHeaders: Map<string, any>
    pendingValues: PendingValue
    websocket: WebSocket
    nextEpochNumber: number

    setSelf: BookUpdateFunc
    doSetPath: ((path: Array<string>, value: any) => void)
    doActionPath: ((path: Array<string>, value: any) => void)

    constructor(setSelf: BookUpdateFunc) {
	this.editable = true;
	this.widgetData = new Map();
	this.widgetHeaders = new Map();
	this.nextEpochNumber = 0;

	this.setSelf = setSelf;
	this.doSetPath = (path: Array<string>, value: any) => {
	    console.log(path, value)

	    setSelf((book) => {
		book.sendMessage({
		    "type": "set",
		    "path": path,
		    "value": value,
		    "epoch": book.nextEpochNumber
		});
		return book.withSetPendingValue(path, value);
	    });
	};
	this.doActionPath = (path: Array<string>, value: any) => {
	    this.sendMessage({type: 'action', path: path, value: value});
	};
	this.pendingValues = new PendingValue([], Immutable.Map({}), this.doSetPath, this.doActionPath);
    }

    withSetPendingValue(path: Array<string>, value: any) {
	let state = this.copy();
	let pendingRoot = replaceValuePath(this.pendingValues.value, path, {
	    value: value,
	    epoch: this.nextEpochNumber
	});
	state.pendingValues = new PendingValue([], pendingRoot, this.doSetPath, this.doActionPath);
	state.nextEpochNumber = this.nextEpochNumber + 1;
	return state;
    }

    sendMessage(data: {type: string} & any) {
	this.websocket.send(JSON.stringify(data));
    }

    copy(): BookState {
	let state = new BookState(this.setSelf);
	state.editable = this.editable;
	state.widgetData = this.widgetData;
	state.widgetHeaders = this.widgetHeaders;
	state.pendingValues = this.pendingValues;
	state.websocket = this.websocket;
	state.nextEpochNumber = this.nextEpochNumber;
	return state;
    }

    withData(key: string, msg: {data: any, header: any}): BookState {
	let state = this.copy();
	state.widgetData.set(key, msg.data);
	state.widgetHeaders.set(key, msg.header);
	return state;
    }

    withServerEpochDone(serverEpoch: number): BookState {
	let state = this.copy();
	state.pendingValues = this.pendingValues.pruneOld(serverEpoch);
	return state;
    }
}

function pendingValueEqual(a: PendingValue, b: PendingValue) {
    return JSON.stringify(a.path) === JSON.stringify(b.path) && a.value === b.value;
}

function renderNode(props: { bookState: BookState, xmlNode: Element }) {
    if (props.xmlNode.nodeName == "text") {
	return <TextWidget bookState={props.bookState} xmlNode={props.xmlNode} />
    } else if (props.xmlNode.nodeName == "table-view" || props.xmlNode.nodeName == "table") {
	return <TableWidget bookState={props.bookState} xmlNode={props.xmlNode} />
    } else if (props.xmlNode.nodeName == "variable-view" || props.xmlNode.nodeName == "variable") {
	return <VariableWidget bookState={props.bookState} xmlNode={props.xmlNode} />
    } else {
	return <div>name {props.xmlNode.nodeName}</div>
    }
}

function TextWidget({ bookState, xmlNode }: { bookState: BookState, xmlNode: Element }) {
    const id = xmlNode.id;
    const [editing, setEditing] = React.useState(false);
    const [editedText, setEditedText] = React.useState();

    const editedOnChange = React.useCallback((ev) => { setEditedText(ev.target.value); }, []);

    const startEdit = React.useCallback(() => {
	setEditedText(xmlNode.textContent);
	setEditing(true);
    }, [xmlNode]);

    const confirmEditing = React.useCallback((e) => {
	e.preventDefault();
	bookState.sendMessage({
	    "type": "doc-set-text",
	    "selector": "[id=" + escapeCssValue(id) + "]",
	    "new_value": editedText
	});
	setEditing(false);
    }, [id, editedText]);

    return (!editing ?
	    <div>
		{xmlNode.textContent || "(empty)"}
		<a href="#" onClick={startEdit}>Edit</a>
	    </div> :
	    <form onSubmit={confirmEditing}>
		<textarea value={editedText} onChange={editedOnChange}></textarea>
		<button>Save</button>
	    </form>);
}

interface TableHeader {
    columns: Array<ColumnInfo>
}

interface ColumnInfo {
    id: string;
    table_id: string;
    type_node: string;
    name: string;
}

function ChooseValueWidget({ value, choices, onChange }: { choices: Array<Element>, value: any, onChange: ((x: any) => void) }) {
    let onChangeCb = React.useCallback((ev) => onChange(ev.target.value), [onChange]);

    return <select value={value} onChange={onChangeCb}>{
	choices.map((child: Element) => <option key={child.id} value={child.id}>{child.id}</option>)
    }</select>;
}

function IntValueWidget({ value, onChange }: { value: any, onChange: ((x: any) => void) }) {
    let onChangeCb = React.useCallback((ev) => onChange(ev.target.value), [onChange]);

    // TODO: onFocus is only to avoid spawning too many record from a new record - this should be fixed in a better way
    return <input type="number" value={value == null ? "" : value} onChange={onChangeCb} onFocus={onChangeCb} />
}

function StringValueWidget({ value, onChange }: { value: any, onChange: ((x: any) => void) }) {
    let onChangeCb = React.useCallback((ev) => onChange(ev.target.value), [onChange]);

    return <input type="text" value={value || ""} onChange={onChangeCb} onFocus={onChangeCb} />
}

const ValueWidget = React.memo(({ typeXml, pendingValue, value }: { typeXml: Element, pendingValue: PendingValue, value: any }) => {
    let currentValue = pendingValue.getValue(value);

    if (typeXml.nodeName == "int") {
	return <IntValueWidget value={currentValue} onChange={pendingValue.doSet} />
    } else if (typeXml.nodeName == "string") {
	return <StringValueWidget value={currentValue} onChange={pendingValue.doSet} />
    } else if (typeXml.nodeName == "choice") {
	return <ChooseValueWidget choices={Array.from(typeXml.children)} value={currentValue} onChange={pendingValue.doSet} />
    } else {
	return <span className="unknown">{ typeXml.nodeName }: { currentValue }</span>
    }
}, (props1, props2) => {
    return pendingValueEqual(props1.pendingValue, props2.pendingValue) && props1.value === props2.value && props1.typeXml == props2.typeXml
})

function VariableWidget({ bookState, xmlNode }: { bookState: BookState, xmlNode: Element }) {
    let id = xmlNode.id;
    let data = bookState.widgetData.get(id);
    let header = bookState.widgetHeaders.get(id);

    if (!header)
	return <div>loading...</div>;

    let typeXml = React.useMemo(() => parseXml(header.type_node), [header.type_node]);
    return <ValueWidget typeXml={typeXml}
			value={data}
			pendingValue={ bookState.pendingValues.sub(id) } />;
}

function TableCell({ pendingValue, columnInfo, value }: { pendingValue: PendingValue, columnInfo: ColumnInfo, value: any }) {
    let name = columnInfo.id;
    let typeString = columnInfo.type_node;
    let typeXml = React.useMemo(() => parseXml(typeString), [typeString]);
    return <td><ValueWidget pendingValue={ pendingValue } typeXml={typeXml} value={value} /></td>
}

function TableRow({ pendingValues, header, row }: { pendingValues: PendingValue, header: TableHeader, row: any }) {
    const [isFocused, setIsFocused] = React.useState(false);
    const onFocus = React.useCallback(() => setIsFocused(true), []);
    const onBlur = React.useCallback(() => setIsFocused(false), []);
    const onKeyUp = React.useCallback((ev) => {
	if (ev.keyCode == 46 /* delete */) {
	    ev.preventDefault();
	    pendingValues.action({'type': 'delete'});
	}
    }, [row, pendingValues]);

    return <tr className={isFocused ? "focused" : ""}>
	<td className="id-cell"
	    tabIndex={0} onFocus={onFocus} onBlur={onBlur}
	    onKeyUp={onKeyUp}>{row._id}</td>
	{header.columns.map((col: ColumnInfo) => (
	    <TableCell key={col.id} columnInfo={col} pendingValue={pendingValues.sub(col.id)} value={row[col.id]} />
	))}
    </tr>
}

function ColumnHeader({ bookState, columnInfo } : { bookState: BookState, columnInfo: ColumnInfo }) {
    const onKeyUp = React.useCallback((ev) => {
	if (ev.keyCode == 46 /* delete */) {
	    ev.preventDefault();
	    bookState.sendMessage({
		'type': 'doc-delete',
		'selector': '[id=' + escapeCssValue(columnInfo.table_id) + '] > [id=' + escapeCssValue(columnInfo.id) + ']'
	    });
	}
    }, [columnInfo, bookState]);

    const cellEditLink = '#column/' + encodeURIComponent(columnInfo.table_id) + '/' + encodeURIComponent(columnInfo.id);

    return <td tabIndex={0}
               onKeyUp={onKeyUp}>{ columnInfo.name } <a href={cellEditLink}>edit</a> </td>
}

function TableWidget({ bookState, xmlNode }: { bookState: BookState, xmlNode: Element }) {
    let id = xmlNode.id;
    let header = bookState.widgetHeaders.get(id);
    let data = bookState.widgetData.get(id);

    if (!header)
	return <div>loading...</div>;

    let nextNewId = data.length == 0 ? 1 : (data[data.length - 1]._id + 1);

    let dataAndNew: Array<any> = Array.from(data);
    dataAndNew.push({_id: null})

    const addColumn = React.useCallback(() => {
	if (xmlNode.nodeName == "table") {
	    bookState.sendMessage({
		'type': 'doc-add',
		'selector': 'table[id=' + escapeCssValue(id) + ']',
		'xml': '<data-col><string/></data-col>'
	    })
	} else {
	    bookState.sendMessage({
		'type': 'doc-add',
		'selector': 'table-view[id=' + escapeCssValue(id) + ']',
		'xml': '<computed-col><python>None</python></computed-col>'
	    })
	}
    }, [bookState, xmlNode, id]);

    return <div>
	<table className="data-table">
	    <thead>
		<tr>
		    <td></td>
		    {header.columns.map((col: ColumnInfo) => {
			return <ColumnHeader
			           bookState={bookState}
				   key={col.id} columnInfo={col} />
		    })}
		    <td>
			<button onClick={addColumn}>+</button>
		    </td>
		</tr>
	    </thead>
	    <tbody>
		{dataAndNew.map((row) => {
		    let key = row._id == null ? nextNewId : row._id;
		    return <TableRow pendingValues={bookState.pendingValues.sub(id).sub(row._id)}
				     header={header} row={row} key={key} />;
		})}
	    </tbody>
	</table>
	<FoldableXmlEditor bookState={bookState} xmlNode={xmlNode} />
    </div>;
}

function LinearLayoutWidget({ bookState, xmlNode }: { bookState: BookState, xmlNode: Element }) {
    const addItemTypeRef = React.useRef();
    const addItem = React.useCallback(() => {
	let type = (addItemTypeRef.current as HTMLSelectElement).value;

	bookState.sendMessage({
	    type: 'doc-add',
	    selector: '[id=' + escapeCssValue(xmlNode.id) + ']',
	    xml: "<" + type + "/>"
	});
    }, [bookState, addItemTypeRef]);

    return <div>
	{ Array.from(xmlNode.children).map((childNode: Element, id: number) =>
	    <div key={id}>{renderNode({ bookState: bookState, xmlNode: childNode })}</div>) }
	{ bookState.editable ? <div>
	    <select ref={addItemTypeRef}>
		<option value="text">Text</option>
		<option value="table">Table</option>
		<option value="table-view">Table view</option>
		<option value="variable">Variable</option>
		<option value="variable-view">Variable view</option>
	    </select>
	    <button onClick={addItem}>Add item</button>
	</div> : null }
    </div>;
}

function parseXml(s: string): Element {
    return new DOMParser().parseFromString(s, "text/xml").children[0];
}

function XmlEditor({ bookState, xmlNode }: { bookState: BookState, xmlNode: Element }) {
    let xmlString = new XMLSerializer().serializeToString(xmlNode)
    return <div>
	<textarea defaultValue={xmlString}></textarea>
    </div>
}

function FoldableXmlEditor(props: { bookState: BookState, xmlNode: Element }) {
    let [visible, setVisible] = React.useState(false);
    return <div>
    <a href="#" onClick={(ev) => {ev.preventDefault(); setVisible(!visible);}}
    style={{'float': 'right'}}>Edit XML</a>
	{ visible ? <XmlEditor {...props} /> : null }
    </div>
}

function ColumnDialog({ locationPath, bookState, xmlNode } : { locationPath : string, bookState: BookState, xmlNode: Element }) {
    let [tableId, columnId] = splitPathAndUnescape(locationPath);

    let columnSelector = "[id=" + escapeCssValue(tableId) + "] [id=" + escapeCssValue(columnId) + "]";
    let tableElem = xmlNode.querySelector("[id=" + escapeCssValue(tableId) + "]");
    let columnElem = tableElem.querySelector("[id=" + escapeCssValue(columnId) + "]");

    let nameRef: React.RefObject<HTMLInputElement> = React.useRef();

    const save = React.useCallback((ev) => {
	ev.preventDefault()
	bookState.sendMessage({
	    "type": "doc-set-attr",
	    "selector": columnSelector,
	    "attrs": {"name": nameRef.current.value}
	})
    }, [bookState, tableId, columnId]);

    return <form onSubmit={save}>
	<b>tableId: {tableId}, columnId: {columnId}</b>
	<div>
	    Name: <input ref={nameRef} defaultValue={columnElem.getAttribute('name')} />
	</div>
	<FoldableXmlEditor bookState={bookState} xmlNode={columnElem} />
	<button>Save</button>
    </form>
}

function DialogContent({ locationPath, bookState, xmlNode } : { locationPath: string, bookState: BookState, xmlNode: Element }) {
    let [name, rest] = split2(locationPath, "/");

    // use key={locationPath} to avoid leaking state between different widgets
    if (name == "column") {
	return <ColumnDialog key={locationPath} locationPath={rest} bookState={bookState} xmlNode={xmlNode} />
    }

    return <b>unknown path {locationPath}</b>;
}

function Main({ locationPath }: { locationPath: string }) {
    const [xmlData, setXmlData] = React.useState();
    const [bookState, setBookState] = React.useState(new BookState((x) => setBookState(x)));
    const xmlNode = React.useMemo(() => xmlData && parseXml(xmlData), [xmlData]);

    function websocketMessage(ev: MessageEvent) {
	let msg = JSON.parse(ev.data);
	if (msg.type == "document") {
	    setXmlData(msg.data);
	} else if (msg.type == "data") {
	    setBookState(bookState => bookState.withData(msg.id, msg));
	} else if (msg.type == "set-done") {
	    setBookState(bookState => bookState.withServerEpochDone(msg.epoch));
	} else {
	    console.log("unknown message", msg)
	}
    }

    React.useEffect(() => {
	bookState.websocket = new WebSocket((location.protocol == 'http:' ? "ws" : "wss") + "://" + location.host + "/websocket");
	bookState.websocket.onmessage = websocketMessage;
    }, []);

    if (xmlNode) {
	const rootSheet = xmlNode.querySelector('rookbook > sheet');
	return <div>
	    {locationPath ?
	     <dialog open>
		 <a href="#" className="close-button">x</a>
		 <DialogContent xmlNode={rootSheet} bookState={bookState} locationPath={locationPath} />
	     </dialog>  : null }
	    <LinearLayoutWidget bookState={bookState} xmlNode={rootSheet} />
	    <pre>{xmlData}</pre>
	</div>;
    } else {
	return <div>loading...</div>;
    }
}

function MainRouter() {
    const [currentLocation, setCurrentLocation] = React.useState(location.hash.slice(1));

    React.useEffect(() => {
	window.addEventListener("hashchange", () => setCurrentLocation(location.hash.slice(1)), false);
    });
    return <Main locationPath={currentLocation} />
}

ReactDOM.render(
    <MainRouter />,
    document.getElementById("body")
);
