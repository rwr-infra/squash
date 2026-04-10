import { Routes, Route } from 'react-router-dom';
import InstanceListPage from './pages/InstanceListPage';
import TerminalPage from './pages/TerminalPage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<InstanceListPage />} />
      <Route path="/terminal/:instanceId" element={<TerminalPage />} />
    </Routes>
  );
}

export default App;