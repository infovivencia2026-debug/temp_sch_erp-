import { NavLink } from 'react-router-dom'
import { BookOpen, Calendar, CheckSquare, ClipboardList, Clock, BellRing } from 'lucide-react'
import { featurePath } from '@/lib/catalog'
import { cn } from '@/lib/utils'

export default function TodaysClasses() {
  const role = 'faculty'

  const BentoCard = ({ to, className, children }: { to: string, className?: string, children: React.ReactNode }) => (
    <NavLink
      to={to}
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden rounded-[24px] p-6 transition-all duration-300",
        "border border-white/5 bg-card shadow-sm hover:shadow-xl hover:-translate-y-1 hover:border-primary/30",
        className
      )}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      {children}
    </NavLink>
  )

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto min-h-[calc(100vh-56px)] bg-muted/20">
      
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">My Class Hub</h1>
        <p className="text-muted-foreground mt-1 text-sm">Welcome back! Here's your overview for today.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 auto-rows-[160px]">
        
        {/* Next Class Hero Widget */}
        <BentoCard 
          to={featurePath(role, 'home', 'my_day')}
          className="md:col-span-2 lg:col-span-2 lg:row-span-2 bg-gradient-to-br from-primary/10 via-primary/5 to-background border-primary/20"
        >
          <div className="flex justify-between items-start">
            <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/70">
              Next Class: Math (10th Grade)
            </h2>
            <div className="p-3 bg-primary/10 rounded-[16px]">
              <Clock className="w-6 h-6 text-primary" />
            </div>
          </div>
          
          <div className="mt-4 space-y-1">
            <p className="text-sm font-medium text-foreground">Room 304</p>
            <p className="text-sm text-muted-foreground">10:15 AM - 11:05 AM (8 mins to go)</p>
          </div>
          
          <div className="mt-auto pt-8">
            <button className="px-6 py-3 bg-primary text-primary-foreground font-semibold rounded-xl shadow-lg shadow-primary/25 hover:bg-primary/90 transition-colors pointer-events-none">
              Start Class
            </button>
          </div>
        </BentoCard>

        {/* Quick Attendance */}
        <BentoCard 
          to={featurePath(role, 'attendance', 'take_attendance')}
          className="md:col-span-2 lg:row-span-2"
        >
          <div className="flex justify-between items-center mb-6">
            <h3 className="font-semibold flex items-center gap-2 text-lg">
              <CheckSquare className="w-5 h-5 text-emerald-500" />
              Quick Attendance
            </h3>
            <span className="text-xs font-medium px-3 py-1 bg-muted rounded-full">Math 10A</span>
          </div>

          <div className="space-y-3 flex-1 overflow-y-auto pr-2">
            {[
              { n: 'Alex R.', p: true },
              { n: 'Ben S.', p: true },
              { n: 'Chloe L.', p: true },
              { n: 'Ryan M.', p: false },
              { n: 'Maie J.', p: false },
            ].map((s, i) => (
              <div key={i} className="flex items-center justify-between p-2.5 rounded-xl bg-muted/50">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 grid place-items-center text-xs font-bold text-primary">
                    {s.n[0]}
                  </div>
                  <span className="text-sm font-medium">{s.n}</span>
                </div>
                {s.p ? (
                  <span className="text-xs px-2 py-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-md font-medium">Present</span>
                ) : (
                  <span className="text-xs px-2 py-1 bg-destructive/10 text-destructive rounded-md font-medium">Absent</span>
                )}
              </div>
            ))}
          </div>
          <div className="mt-4 text-xs font-medium text-emerald-600 text-right">
            26/28 Present
          </div>
        </BentoCard>

        {/* Unmarked Assignments */}
        <BentoCard 
          to={featurePath(role, 'teaching', 'assignments_submissions')}
        >
          <div className="flex items-center justify-between">
            <ClipboardList className="w-6 h-6 text-blue-500" />
            <span className="text-4xl font-bold text-foreground">17</span>
          </div>
          <div className="mt-auto">
            <h3 className="font-semibold text-foreground text-sm">Unmarked Assignments</h3>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">• History Essay (31/32)<br/>• Chem Quiz (20/24)</p>
          </div>
        </BentoCard>

        {/* Lesson Plan */}
        <BentoCard 
          to={featurePath(role, 'teaching', 'lesson_plans_content')}
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-foreground flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-purple-500" />
              Lesson Plan
            </h3>
          </div>
          <div className="mt-auto space-y-3">
            <p className="text-sm font-medium leading-tight">Algebra II: Linear Functions</p>
            <div className="px-3 py-2 bg-muted/50 rounded-[10px]">
              <p className="text-xs font-medium">Chem Quiz <span className="text-muted-foreground float-right">20/24</span></p>
            </div>
          </div>
        </BentoCard>

        {/* Student Alerts */}
        <BentoCard 
          to={featurePath(role, 'my_classes', 'student_behavior_demerits')}
          className="bg-destructive/5 border-destructive/20 hover:border-destructive/40"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-destructive flex items-center gap-2">
              <BellRing className="w-5 h-5" />
              Student Alerts
            </h3>
          </div>
          <div className="mt-auto space-y-3">
            <div className="flex gap-2 items-start">
              <div className="w-2 h-2 mt-1.5 rounded-full bg-destructive shrink-0" />
              <div>
                <p className="text-xs font-medium text-foreground">Alex T. absent 3 days</p>
                <p className="text-[10.5px] text-muted-foreground">Follow up required</p>
              </div>
            </div>
            <div className="flex gap-2 items-start">
              <div className="w-2 h-2 mt-1.5 rounded-full bg-amber-500 shrink-0" />
              <div>
                <p className="text-xs font-medium text-foreground">Emma S. missing assignment</p>
                <p className="text-[10.5px] text-muted-foreground">Math 10th Grade</p>
              </div>
            </div>
          </div>
        </BentoCard>

        {/* Class Schedule */}
        <BentoCard 
          to={featurePath(role, 'timetable', 'my_timetable')}
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-foreground flex items-center gap-2 text-sm">
              <Calendar className="w-5 h-5 text-orange-500" />
              Today's Schedule
            </h3>
          </div>
          <div className="mt-auto space-y-2 text-[13px]">
            <div className="flex justify-between items-center py-1.5 border-b border-white/5">
              <span className="text-muted-foreground">09:00</span>
              <span className="font-medium text-foreground">History 9B</span>
            </div>
            <div className="flex justify-between items-center py-1.5 border-b border-white/5 bg-primary/10 rounded-[8px] px-2 -mx-2">
              <span className="text-primary font-medium">10:15</span>
              <span className="text-primary font-medium">Math 10A</span>
            </div>
            <div className="flex justify-between items-center py-1.5">
              <span className="text-muted-foreground">11:05</span>
              <span className="font-medium text-foreground">Physics 11C</span>
            </div>
          </div>
        </BentoCard>

      </div>
    </div>
  )
}
