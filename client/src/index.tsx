import * as React from "react";
import * as ReactDOM from "react-dom";
import * as Immutable from "immutable";

let globalWebsocket: WebSocket = null

function escapeCssValue(value: string) {
    return '"' + value + '"'; // TODO: incorrect and unsafe!
}

function replaceValuePath(value: any, path: Array<string>, newValue: any): any {
    if (path.length == 0) {
	return newValue;
    } else {
	if (value && !value.asImmutable) throw "this pending value has no subvalues";
	let oldContainer = value ? value.get(path[0]) : Immutable.Map({});
	let newContainer = replaceValuePath(oldContainer, path.slice(1), newValue);
	return (value || Immutable.Map()).set(path[0], newContainer);
    }
}

function immutableMap<K, V>(m: Immutable.Map<K, V>, f: ((v: V) => V)): Immutable.Map<K, V> {
    let anythingChanged = false;
    let result = m.map((v: V) => {
	const v1 = f(v);
	if (v !== v1) anythingChanged = true;
	return v1;
    });
    if (anythingChanged) return result;
    else return m;
}

function pruneOldAux(maxEpoch: number, value: any): any {
    if (!value) {
	return null;
    } else if (typeof value.epoch != "undefined") { // fixme: ugly type check
	if (maxEpoch >= value.epoch) return null;
	return value;
    } else {
	if (!value.asImmutable) throw "bad type?";
	return immutableMap(value, (v) => pruneOldAux(maxEpoch, v));
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

    const cellEditLink = '#/column/' + encodeURIComponent(columnInfo.table_id) + '/' + encodeURIComponent(columnInfo.id);

    return <td tabIndex={0}
               onKeyUp={onKeyUp}>{ columnInfo.id } <a href={cellEditLink}>edit</a> </td>
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
		'xml': '<data-col id="column1"><string/></data-col>'
	    })
	} else {
	    bookState.sendMessage({
		'type': 'doc-add',
		'selector': 'table-view[id=' + escapeCssValue(id) + ']',
		'xml': '<computed-col id="column1"><python>None</python></computed-col>'
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
    </div>;
}

function LinearLayoutWidget({ bookState, xmlNode }: { bookState: BookState, xmlNode: Element }) {
    const addItemTypeRef = React.useRef();
    const addItem = React.useCallback(() => {
	let type = (addItemTypeRef.current as HTMLSelectElement).value;

	bookState.sendMessage({
	    type: 'doc-add-widget',
	    parentId: xmlNode.id,
	    element: type
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

function Main({ currentLocation }: { currentLocation: string }) {
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
	    <div>location: {currentLocation}</div>
	    <LinearLayoutWidget bookState={bookState} xmlNode={rootSheet} />
	    <pre>{xmlData}</pre>
	</div>;
    } else {
	return <div>loading...</div>;
    }
}

function MainRouter() {
    const [currentLocation, setCurrentLocation] = React.useState(location.hash);

    React.useEffect(() => {
	window.addEventListener("hashchange", () => setCurrentLocation(location.hash), false);
    });
    return <Main currentLocation={currentLocation} />
}

ReactDOM.render(
    <MainRouter />,
    document.getElementById("body")
);
