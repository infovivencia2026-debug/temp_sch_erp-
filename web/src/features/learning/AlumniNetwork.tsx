import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users2, HandHeart, BadgeCheck } from 'lucide-react'
import { api, type List } from '@/lib/api'
import {
  PageHead, PageBody, Card, CardHeader, CellGrid, Stat, Badge, Button, Field,
  FormGrid, FormNotice, Input, Select, Textarea, Checkbox,
  SkeletonTiles, ErrorState, EmptyState,
} from '@/components/ui'
import { useChildren, studentQuery, readyFor } from './use-student'
import { ChildBar } from './ChildBar'

interface Profile {
  id: string
  student_id: string
  name: string
  batch_year: number
  current_status: string
  institution_name?: string
  employer?: string
  designation?: string
  city?: string
  country?: string
  contact_email?: string
  contact_phone?: string
  profile_url?: string
  willing_to_mentor: boolean
  willing_to_post_jobs: boolean
  is_listed: boolean
  show_contact: boolean
  bio?: string
  is_verified: boolean
  registered_on: string
}
interface ProfileResponse {
  student_id: string
  registered: boolean
  profile: Profile | null
}

const STATUSES = [
  { value: 'school', label: 'Still at school' },
  { value: 'higher_secondary', label: 'Higher secondary elsewhere' },
  { value: 'undergraduate', label: 'Undergraduate' },
  { value: 'postgraduate', label: 'Postgraduate' },
  { value: 'working', label: 'Working' },
  { value: 'entrepreneur', label: 'Running my own thing' },
  { value: 'other', label: 'Something else' },
]

/* Staying findable after the last day.

   Two consents, not one. Being listed decides whether you appear at all;
   showing contact decides whether your email and telephone travel with you.
   They are separate switches because they are separate decisions, and a
   directory that treated them as one would quietly become a mailing list.

   The school's tick is the school's to give. Nothing on this form sets it,
   which is the only reason it means anything. */
export default function AlumniNetwork() {
  const qc = useQueryClient()
  const { children, studentId, chosen, setChosen } = useChildren()
  const ready = readyFor(children, studentId)

  const mine = useQuery({
    queryKey: ['alumni-profile', studentId],
    queryFn: () =>
      api.get<ProfileResponse>(`/api/v1/portal/alumni/profile${studentQuery(studentId)}`),
    enabled: ready,
  })

  const directory = useQuery({
    queryKey: ['alumni-directory'],
    queryFn: () => api.get<List<Profile>>('/api/v1/portal/alumni/directory'),
    enabled: ready,
  })

  const [batch, setBatch] = useState('')
  const [status, setStatus] = useState('school')
  const [institution, setInstitution] = useState('')
  const [employer, setEmployer] = useState('')
  const [designation, setDesignation] = useState('')
  const [city, setCity] = useState('')
  const [country, setCountry] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [url, setUrl] = useState('')
  const [mentor, setMentor] = useState(false)
  const [postsJobs, setPostsJobs] = useState(false)
  const [listed, setListed] = useState(true)
  const [showContact, setShowContact] = useState(false)
  const [bio, setBio] = useState('')

  // Fill the form from what was registered, once, so an edit starts from the
  // truth rather than from an empty form that would blank half the record.
  const loaded = mine.data?.profile
  useEffect(() => {
    if (!loaded) return
    setBatch(String(loaded.batch_year))
    setStatus(loaded.current_status)
    setInstitution(loaded.institution_name ?? '')
    setEmployer(loaded.employer ?? '')
    setDesignation(loaded.designation ?? '')
    setCity(loaded.city ?? '')
    setCountry(loaded.country ?? '')
    setEmail(loaded.contact_email ?? '')
    setPhone(loaded.contact_phone ?? '')
    setUrl(loaded.profile_url ?? '')
    setMentor(loaded.willing_to_mentor)
    setPostsJobs(loaded.willing_to_post_jobs)
    setListed(loaded.is_listed)
    setShowContact(loaded.show_contact)
    setBio(loaded.bio ?? '')
  }, [loaded])

  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/portal/alumni/profile', {
        student_id: studentId || undefined,
        batch_year: batch ? Number(batch) : undefined,
        current_status: status,
        institution_name: institution || undefined,
        employer: employer || undefined,
        designation: designation || undefined,
        city: city || undefined,
        country: country || undefined,
        contact_email: email || undefined,
        contact_phone: phone || undefined,
        profile_url: url || undefined,
        willing_to_mentor: mentor,
        willing_to_post_jobs: postsJobs,
        is_listed: listed,
        show_contact: showContact,
        bio: bio || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alumni-profile'] })
      qc.invalidateQueries({ queryKey: ['alumni-directory'] })
    },
  })

  if (mine.isLoading && ready) return <SkeletonTiles count={3} label="Looking up your registration…" />
  if (mine.error) return <ErrorState error={mine.error} />

  const rows = directory.data?.items ?? []
  const mentors = rows.filter((p) => p.willing_to_mentor).length

  return (
    <>
      <PageHead
        eyebrow="Alumni"
        title="Alumni network"
        description="Register so the school and your year group can still find you after you leave."
      />
      <PageBody>
        <ChildBar kids={children} value={chosen} onChange={setChosen} />

        {!ready ? (
          <EmptyState title="Choose a child" body="A registration is in one leaver's name." />
        ) : (
          <>
            <CellGrid cols={3}>
              <Stat
                label="Your registration"
                value={mine.data?.registered ? 'Registered' : 'Not yet'}
                icon={Users2}
                hint={loaded?.is_verified ? 'Verified by the school' : 'Awaiting the school’s tick'}
              />
              <Stat label="In the directory" value={rows.length} icon={BadgeCheck} />
              <Stat label="Willing to mentor" value={mentors} icon={HandHeart} />
            </CellGrid>

            <Card>
              <CardHeader
                title={mine.data?.registered ? 'Your details' : 'Register'}
                description="Nothing here is compulsory except the year you leave. You can come back and change any of it."
              />
              <div className="space-y-5 p-5">
                <FormGrid>
                  <Field label="Year you leave (or left)" required>
                    <Input value={batch} onChange={setBatch} type="number" placeholder="2032" />
                  </Field>
                  <Field label="What you are doing now">
                    <Select value={status} onChange={setStatus} options={STATUSES} />
                  </Field>
                  <Field label="College or university">
                    <Input value={institution} onChange={setInstitution}
                      placeholder="IIT Hyderabad" />
                  </Field>
                  <Field label="Employer">
                    <Input value={employer} onChange={setEmployer} placeholder="Vivencia Labs" />
                  </Field>
                  <Field label="Role">
                    <Input value={designation} onChange={setDesignation}
                      placeholder="Software engineer" />
                  </Field>
                  <Field label="City">
                    <Input value={city} onChange={setCity} placeholder="Hyderabad" />
                  </Field>
                  <Field label="Country">
                    <Input value={country} onChange={setCountry} placeholder="India" />
                  </Field>
                  <Field label="Profile link" hint="Somewhere the school can point people to.">
                    <Input value={url} onChange={setUrl} placeholder="https://…" />
                  </Field>
                  <Field label="Email">
                    <Input value={email} onChange={setEmail} type="email"
                      placeholder="you@example.com" />
                  </Field>
                  <Field label="Phone">
                    <Input value={phone} onChange={setPhone} placeholder="+91…" />
                  </Field>
                  <Field label="A line about yourself" wide>
                    <Textarea value={bio} onChange={setBio} rows={2}
                      placeholder="Reading electronics; happy to talk to anyone thinking about it." />
                  </Field>
                </FormGrid>

                <div className="space-y-3 rounded-md border bg-muted/30 p-4">
                  <p className="text-[13px] font-medium">What others can see</p>
                  <Checkbox checked={listed} onChange={setListed}
                    label="List me in the alumni directory"
                    hint="Turn this off and nobody sees your entry at all." />
                  <Checkbox checked={showContact} onChange={setShowContact}
                    label="Show my email and phone alongside it"
                    hint="Off by default. Being findable is not the same as publishing a number." />
                  <Checkbox checked={mentor} onChange={setMentor}
                    label="I am happy to mentor current students" />
                  <Checkbox checked={postsJobs} onChange={setPostsJobs}
                    label="I may have work experience or internships to offer" />
                </div>

                <FormNotice error={save.error} ok={save.isSuccess ? 'Saved.' : undefined} />
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : mine.data?.registered ? 'Save changes' : 'Register'}
                </Button>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="The directory"
                description="Everyone who has chosen to be listed. Contact details appear only where the person allowed it."
              />
              {rows.length === 0 ? (
                <EmptyState
                  title="Nobody listed yet"
                  body="As leavers register they appear here, newest year group first."
                />
              ) : (
                <ul className="divide-y">
                  {rows.map((p) => (
                    <li key={p.id} className="px-5 py-4">
                      <p className="text-[14px] font-medium">
                        {p.name}
                        <Badge>Class of {p.batch_year}</Badge>
                        {p.is_verified && <Badge tone="success">Verified</Badge>}
                        {p.willing_to_mentor && <Badge tone="info">Mentors</Badge>}
                      </p>
                      <p className="mt-1 text-[13px] text-muted-foreground">
                        {[p.designation, p.employer ?? p.institution_name]
                          .filter(Boolean)
                          .join(' at ') || p.current_status.replace('_', ' ')}
                        {p.city ? ` · ${p.city}` : ''}
                        {p.country ? `, ${p.country}` : ''}
                      </p>
                      {p.bio && <p className="mt-1 text-[13px] text-muted-foreground">{p.bio}</p>}
                      {(p.contact_email || p.contact_phone || p.profile_url) && (
                        <p className="mt-1 text-[12.5px] text-muted-foreground">
                          {[p.contact_email, p.contact_phone].filter(Boolean).join(' · ')}
                          {p.profile_url && (
                            <>
                              {p.contact_email || p.contact_phone ? ' · ' : ''}
                              <a href={p.profile_url} target="_blank" rel="noreferrer noopener"
                                className="underline underline-offset-2 hover:text-primary">
                                profile
                              </a>
                            </>
                          )}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </PageBody>
    </>
  )
}
