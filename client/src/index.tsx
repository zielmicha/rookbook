import * as React from "react";
import * as ReactDOM from "react-dom";
import * as Immutable from "immutable";

let globalWebsocket: WebSocket = null

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

class PendingValue {
    path: Array<string>
    value: any
    doSet: ((x: any) => void);
    doSetPath: ((path: Array<string>, value: any) => void);

    constructor(path: Array<string>, value: any, doSetPath: ((path: Array<string>, value: any) => void)) {
	this.path = path;
	this.value = value;
	this.doSet = (x) => {
	    doSetPath(this.path, x);
	};
	this.doSetPath = doSetPath;
    }

    getValue(defaultValue: any) {
	if (!this.value) return defaultValue;
	return this.value.value;
    }

    sub(name: string): PendingValue {
	if (this.value && !this.value.asImmutable) throw "this pending value has no subvalues";
	return new PendingValue(this.path.concat(name), this.value ? this.value.get(name) : null, this.doSetPath);
    }
}

class BookState {
    editable: boolean
    widgetData: Map<string, any>
    widgetHeaders: Map<string, any>
    pendingValues: PendingValue

    setSelf: ((n: BookState) => void)
    doSetPath: ((path: Array<string>, value: any) => void)

    constructor(setSelf: ((n: BookState) => void)) {
	this.editable = true
	this.widgetData = new Map();
	this.widgetHeaders = new Map();

	this.setSelf = setSelf;
	this.doSetPath = (path: Array<string>, value: any) => {
	    setSelf(this.withSetPendingValue(path, value));
	};
	this.pendingValues = new PendingValue([], Immutable.Map({}), this.doSetPath);
    }

    withSetPendingValue(path: Array<string>, value: any) {
	let state = this.copy();
	let pendingRoot = replaceValuePath(this.pendingValues.value, path, {
	    value: value,
	    epoch: 66
	});
	state.pendingValues = new PendingValue([], pendingRoot, this.doSetPath)
	return state;
    }

    copy(): BookState {
	let state = new BookState(this.setSelf);
	state.editable = this.editable;
	state.widgetData = this.widgetData;
	state.widgetHeaders = this.widgetHeaders;
	state.pendingValues = this.pendingValues;
	return state;
    }

    withData(key: string, msg: {data: any, header: any}): BookState {
	let state = this.copy();
	state.widgetData.set(key, msg.data);
	state.widgetHeaders.set(key, msg.header);
	return state;
    }
}

function renderNode(props: { bookState: BookState, xmlNode: Element }) {
    if (props.xmlNode.nodeName == "text") {
	return <TextWidget bookState={props.bookState} xmlNode={props.xmlNode} />
    } else if (props.xmlNode.nodeName == "table-view" || props.xmlNode.nodeName == "table") {
	return <TableWidget bookState={props.bookState} xmlNode={props.xmlNode} />
    } else {
	return <div>name {props.xmlNode.nodeName}</div>
    }
}

function TextWidget(props: { bookState: BookState, xmlNode: Element }) {
    return <div>
	{props.xmlNode.textContent}
    </div>;
}

interface TableHeader {
    columns: Array<[string, any]>
}

function ChooseValueWidget({ value, choices, onChange }: { choices: Array<Element>, value: any, onChange: ((x: any) => void) }) {
    return <select></select>;
}

function IntValueWidget({ value, onChange }: { value: any, onChange: ((x: any) => void) }) {
    let onChangeCb = React.useCallback((ev) => onChange(ev.target.value), [onChange]);

    return <input type="number" value={value || 0} onChange={onChangeCb} />
}

function ValueWidget({ typeXml, pendingValue, value }: { typeXml: Element, pendingValue: PendingValue, value: any }) {
    let currentValue = pendingValue.getValue(value);

    if (typeXml.nodeName == "int") {
	return <IntValueWidget value={currentValue} onChange={pendingValue.doSet} />
    } else if (typeXml.nodeName == "choice") {
	return <ChooseValueWidget choices={Array.from(typeXml.children)} value={currentValue} onChange={pendingValue.doSet} />
    } else {
	return <span className="unknown">{ typeXml.nodeName }: { currentValue }</span>
    }
}

function TableRow({ pendingValues, header, row }: { pendingValues: PendingValue, header: TableHeader, row: any }) {
    return <tr>
	<td>{row._id}</td>
	{header.columns.map((col: [string, any]) => {
	    let [name, typeString] = col;
	    let typeXml = parseXml(typeString.type_node);
	    let value = row[name];
	    return <td key={name}><ValueWidget pendingValue={ pendingValues.sub(name) } typeXml={typeXml} value={value} /></td>
	})}
    </tr>
}

function TableWidget({ bookState, xmlNode }: { bookState: BookState, xmlNode: Element }) {
    let id = xmlNode.id;
    let header = bookState.widgetHeaders.get(id);
    let data = bookState.widgetData.get(id);

    if (!header)
	return <div>loading...</div>;

    let dataAndNew: Array<any> = Array.from(data);
    dataAndNew.push({_id: null})

    return <div>
	<table className="data-table">
	    <thead>
		<tr>
		    <td></td>
		    {header.columns.map((col: [string, string]) => {
			let [name, _] = col;
			return <td key={name}>{name}</td>
		    })}
		</tr>
	    </thead>
	    <tbody>
		{dataAndNew.map((row) => {
		    return <TableRow pendingValues={bookState.pendingValues.sub(id).sub(row._id)} header={header} row={row} key={row._id} />;
		})}
	    </tbody>
	</table>
    </div>;
}

function LinearLayoutWidget(props: { bookState: BookState, xmlNode: Element }) {
    const addItemTypeRef = React.useRef();
    const addItem = React.useCallback(() => {

    }, [props.bookState]);

    return <div>
	{ Array.from(props.xmlNode.children).map((childNode: Element, id: number) =>
	    <div key={id}>{renderNode({ bookState: props.bookState, xmlNode: childNode })}</div>) }
	{ props.bookState.editable ? <div>
	    <select ref={addItemTypeRef}>
		<option>Text</option>
		<option>Table</option>
		<option>Computed value</option>
	    </select>
	    <button onClick={addItem}>Add item</button>
	</div> : null }
    </div>;
}

function parseXml(s: string): Element {
    return new DOMParser().parseFromString(s, "text/xml").children[0];
}

function Main() {
    const [xmlNode, setXmlNode] = React.useState();
    const [bookState, setBookState] = React.useState(new BookState((x) => setBookState(x)));

    function websocketMessage(ev: MessageEvent) {
	let msg = JSON.parse(ev.data);
	if (msg.type == "document") {
	    setXmlNode(parseXml(msg.data));
	} else if (msg.type == "data") {
	    setBookState(bookState.withData(msg.id, msg));
	}
    }

    React.useEffect(() => {
	globalWebsocket = new WebSocket((location.protocol == 'http:' ? "ws" : "wss") + "://" + location.host + "/websocket");
	globalWebsocket.onmessage = websocketMessage;
    }, []);

    if (xmlNode) {
	const rootSheet = xmlNode.querySelector('rookbook > sheet');
	return <LinearLayoutWidget bookState={bookState} xmlNode={rootSheet} />;
    } else {
	return <div>loading...</div>;
    }
}

ReactDOM.render(
    <Main />,
    document.getElementById("body")
);
