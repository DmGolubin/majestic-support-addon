import { React } from "./common";
export default class ErrorBoundary extends React.Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error: unknown) { this.props.onError?.({ error }); }
    render() { return this.state.failed ? null : this.props.children; }
}
