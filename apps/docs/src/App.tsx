import { Navigate, Route, Routes } from "react-router-dom";
import { DocLayout } from "@/components/DocLayout";
import {
  HomePage,
  InstallationPage,
  GettingStartedPage,
  ArchitecturePage,
  FeaturesPage,
  BuildPipelinePage,
  DeploymentPage,
  PlansPage,
  DataModelPage,
} from "@/pages";

export function App() {
  return (
    <Routes>
      <Route element={<DocLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/installation" element={<InstallationPage />} />
        <Route path="/getting-started" element={<GettingStartedPage />} />
        <Route path="/architecture" element={<ArchitecturePage />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/build-pipeline" element={<BuildPipelinePage />} />
        <Route path="/deployment" element={<DeploymentPage />} />
        <Route path="/plans" element={<PlansPage />} />
        <Route path="/data-model" element={<DataModelPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
