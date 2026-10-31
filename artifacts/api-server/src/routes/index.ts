import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import studentsRouter from "./students";
import classroomsRouter from "./classrooms";
import attendanceRouter from "./attendance";
import faceRouter from "./face";
import smsLogsRouter from "./sms-logs";
import dashboardRouter from "./dashboard";
import adminsRouter from "./admins";
import piRouter from "./pi";
import jobsRouter from "./jobs";
import operationsRouter from "./operations";
import bulkAttendanceRouter from "./bulk-attendance";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(studentsRouter);
router.use(classroomsRouter);
router.use(attendanceRouter);
router.use(faceRouter);
router.use(smsLogsRouter);
router.use(dashboardRouter);
router.use(adminsRouter);
router.use(piRouter);
router.use(jobsRouter);
router.use(operationsRouter);
router.use(bulkAttendanceRouter);

export default router;
