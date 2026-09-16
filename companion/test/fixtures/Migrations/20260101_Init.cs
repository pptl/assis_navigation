using Microsoft.EntityFrameworkCore.Migrations;

namespace Demo.Migrations
{
    public partial class Init : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_Vehicles_PlateNo",
                table: "Vehicles",
                column: "PlateNo",
                unique: true);
        }
    }

    public class DemoContext
    {
        protected void OnModelCreating(dynamic modelBuilder)
        {
            modelBuilder.Entity<Application>()
                .HasIndex(e => new { e.ApplicantName, e.Month })
                .IsUnique();
            modelBuilder.Entity<Vehicle>().HasIndex(v => v.PlateNo).IsUnique();
        }
    }
}
