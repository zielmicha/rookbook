import * as Immutable from "immutable";

export function escapeCssValue(value: string) {
    return '"' + value + '"'; // TODO: incorrect and unsafe!
}

export function split2(a: string, sep: string): [string, string] {
    let loc = a.indexOf(sep);
    if (loc == -1)
	return [a, ""];
    else
	return [a.slice(0, loc), a.slice(loc + sep.length)];
}

export function splitPathAndUnescape(a: string): Array<string> {
    return a.split("/").map(decodeURIComponent);
}

export function replaceValuePath(value: any, path: Array<string>, newValue: any): any {
    if (path.length == 0) {
	return newValue;
    } else {
	if (value && !value.asImmutable) throw "this pending value has no subvalues";
	let oldContainer = value ? value.get(path[0]) : Immutable.Map({});
	let newContainer = replaceValuePath(oldContainer, path.slice(1), newValue);
	return (value || Immutable.Map()).set(path[0], newContainer);
    }
}

export function immutableMap<K, V>(m: Immutable.Map<K, V>, f: ((v: V) => V)): Immutable.Map<K, V> {
    let anythingChanged = false;
    let result = m.map((v: V) => {
	const v1 = f(v);
	if (v !== v1) anythingChanged = true;
	return v1;
    });
    if (anythingChanged) return result;
    else return m;
}
