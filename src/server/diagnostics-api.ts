import { Router } from "express";
import { diagnosticStore } from "../core/diagnostics.ts";

export const diagnosticsApi = Router();
diagnosticsApi.get("/runtime/logs", async (req,res) => res.json(await diagnosticStore().query(req.query)));
diagnosticsApi.get("/runtime/logs/export", async (req,res) => {
  const page = await diagnosticStore().query({ ...req.query, limit: 200 });
  res.setHeader("Content-Disposition", 'attachment; filename="content-studio-diagnostics.json"');
  res.json(page);
});
