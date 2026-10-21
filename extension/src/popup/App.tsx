import { HashRouter, Route, Routes } from "react-router-dom";
import { AboutPage } from "./pages/About";
import { AddCMSPage } from "./pages/AddCMS";
import { HistoryPage } from "./pages/History";
import { HomeNew } from "./pages/HomeNew";

export function App() {
  return (
    <HashRouter>
      <div className="flex flex-col h-full min-h-[500px]">
        <Routes>
          <Route path="/" element={<HomeNew />} />
          <Route path="/add-cms" element={<AddCMSPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
